import { all, one, run, audit, enqueue, enqueueOnce, enqueueMany, enqueueComputeOnce } from './db.js';
import { latestDefinition } from './define.js';
import { nowIso, uid, mulberry32, randn, clamp, safeJson, hashString, mean, sha256Hex, stableStringify } from './util.js';
import { wilson, normInv } from './stats.js';
import { loadEmpiricalCalibration, empiricalScenarioFromEpisode } from './empirical.js';
import { ensureFrozenProtocol, assertProtocolIntegrity, ENGINE_VERSION } from './rigor.js';
import { cached } from './memo.js';
import { officialValidationScenarios } from './official_mapping.js';

const EPS=1e-9;
const ESTIMATORS=['ema','kalman','changepoint','adaptive'];
const PROB_CONSTRAINTS={loss_exceed_rate:'loss_exceed_max',fp_rate:'fp_max',fn_rate:'fn_max'};
const MEAN_CONSTRAINTS={review_burden:'review_burden_max',recovery_time:'recovery_time_max'};

function normalCI(mu,sd,n,z=1.96){
  if(!n) return {mean:0,lo:-Infinity,hi:Infinity};
  const se=(sd||0)/Math.sqrt(Math.max(1,n));
  return {mean:mu,lo:mu-z*se,hi:mu+z*se};
}
function sampleSd(sum,sumSq,n){ if(n<2) return 0; return Math.sqrt(Math.max(0,(sumSq-sum*sum/n)/(n-1))); }
function logistic(x){ return 1/(1+Math.exp(-x)); }
function empiricalChannel(cal,S,C){
  return clamp(cal.coeff.kappa + cal.coeff.theta1*S + cal.coeff.theta2*C*S, 0, 0.75);
}
function scenarioFromRow(r,cal){
  const meta=safeJson(r?.metadata_json,{});
  const S=clamp(Number(meta.severity??r?.severity??cal.params.baseline_shock?.value??0.75),0,1);
  const C=clamp(Number(meta.concentration??cal.params.korea_concentration_anchor?.value??0.75),0,1);
  const D=clamp(Number(meta.digital_adoption??cal.params.korea_digital_adoption?.value??0.92),0,1);
  return {
    key:String(r?.id||r?.name||'scenario'), name:r?.name||'scenario', severity:S, concentration:C,digital:D,
    empirical_outflow:Number(meta.empirical_outflow??empiricalChannel(cal,S,C)),
    volatility:Number(r?.volatility||1), delay_multiplier:Number(r?.delay_multiplier||1), loss_multiplier:Number(r?.loss_multiplier||1),
    drift:Number(meta.drift||0), rho:Number(meta.rho??0.82), shift_time:Number(meta.shift_time??-1),
    shift_magnitude:Number(meta.shift_magnitude||0), process_noise:Number(meta.process_noise??Math.max(.015,cal.coeff.rmse)),
    provenance:meta.provenance||'scenario_table', validation_group:meta.validation_group||null
  };
}
function syntheticScenarios(cal){
  const baseS=Number(cal.params.baseline_shock?.value??.75), C=Number(cal.params.korea_concentration_anchor?.value??.75), D=Number(cal.params.korea_digital_adoption?.value??.92), rmse=Math.max(.015,cal.coeff.rmse);
  const base=empiricalChannel(cal,baseS,C);
  return [
    {key:'paper_korea_baseline',name:'Published Korea baseline anchor',severity:baseS,concentration:C,digital:D,empirical_outflow:base,volatility:1,delay_multiplier:1,loss_multiplier:1,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'published_summary_anchor',validation_group:'Synthetic'},
    {key:'paper_low_shock',name:'Published low-shock sensitivity',severity:.60,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,.60,C),volatility:1.05,delay_multiplier:1,loss_multiplier:1.05,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'published_summary_anchor',validation_group:'Synthetic'},
    {key:'paper_high_shock',name:'Published high-shock sensitivity',severity:.90,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,.90,C),volatility:1.15,delay_multiplier:1.10,loss_multiplier:1.15,drift:0,rho:.80,shift_time:12,shift_magnitude:.10,process_noise:rmse*1.25,provenance:'published_summary_anchor',validation_group:'Synthetic'},
    {key:'paper_low_digital',name:'Published low-digital sensitivity',severity:baseS,concentration:C,digital:.30,empirical_outflow:base,volatility:.92,delay_multiplier:1,loss_multiplier:.95,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'published_summary_anchor',validation_group:'Synthetic'}
  ];
}
function paperStressScenarios(cal){
  const out=[];
  for(const cm of [.6,1,1.4]) for(const dm of [.6,1,1.4]) for(const sm of [.6,1,1.4]){
    const C=clamp(Number(cal.params.korea_concentration_anchor?.value??.75)*cm,0,1),D=clamp(Number(cal.params.korea_digital_adoption?.value??.92)*dm,0,1),S=clamp(Number(cal.params.baseline_shock?.value??.75)*sm,0,1);
    out.push({key:`paper_wide_${cm}_${dm}_${sm}`,name:`±40% C/D/S (${cm},${dm},${sm})`,severity:S,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,S,C),volatility:1+.25*Math.abs(sm-1),delay_multiplier:1+.25*Math.max(0,sm-1),loss_multiplier:1+.35*Math.max(0,sm-1),drift:0,rho:.80,shift_time:S>.85?10:-1,shift_magnitude:S>.85?.12:0,process_noise:Math.max(.015,cal.coeff.rmse)*(1+.4*Math.abs(sm-1)),provenance:'paper_robustness_grid',validation_group:'Adversarial'});
  }
  return out;
}

function calibrationUncertaintyScenarios(cal){
  const reps=cal.local_refit?.uncertainty?.representative_draws||[];
  if(!reps.length)return [];
  const S=Number(cal.params.baseline_shock?.value??.75),C=Number(cal.params.korea_concentration_anchor?.value??.75),D=Number(cal.params.korea_digital_adoption?.value??.92),rmse=Math.max(.015,cal.coeff.rmse);
  return reps.map((b,i)=>({key:`calibration_boot_${i}`,name:`Calibration uncertainty draw ${i+1}`,severity:S,concentration:C,digital:D,empirical_outflow:clamp(Number(b.kappa)+Number(b.theta1)*S+Number(b.theta2)*C*S,0,.75),volatility:1,delay_multiplier:1,loss_multiplier:1,drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:Math.max(.015,Number(b.rmse||rmse)),provenance:'empirical_bootstrap_uncertainty',validation_group:'Adversarial'}));
}
function lossProxyScenarios(cal){
  const L=cal.loss||{}; if(L.identification_status!=='PROXY_ONLY'||!Number.isFinite(Number(L.c_fp))||!Number.isFinite(Number(L.c_fn)))return [];
  const baseS=Number(cal.params.baseline_shock?.value??.75),C=Number(cal.params.korea_concentration_anchor?.value??.75),D=Number(cal.params.korea_digital_adoption?.value??.92),rmse=Math.max(.015,cal.coeff.rmse);
  const fps=[Number(L.c_fp_low||L.c_fp),Number(L.c_fp_high||L.c_fp)],fns=[Number(L.c_fn_low||L.c_fn),Number(L.c_fn_high||L.c_fn)],out=[];
  for(const fp of fps)for(const fn of fns)out.push({key:`loss_proxy_${fp.toFixed(4)}_${fn.toFixed(4)}`,name:'FP/FN proxy-cost sensitivity',severity:baseS,concentration:C,digital:D,empirical_outflow:empiricalChannel(cal,baseS,C),volatility:1,delay_multiplier:1,loss_multiplier:1,c_fp_multiplier:fp/Math.max(EPS,Number(L.c_fp)),c_fn_multiplier:fn/Math.max(EPS,Number(L.c_fn)),drift:0,rho:.82,shift_time:-1,shift_magnitude:0,process_noise:rmse,provenance:'loss_proxy_sensitivity',validation_group:'Adversarial'});
  return out;
}
function estimatorStep(kind,state,y,alpha,sigma){
  const a=clamp(alpha,.03,.97);
  if(kind==='kalman' || kind==='adaptive'){
    const q=.02+.30*a*a, r=Math.max(.0025,sigma*sigma);
    const pred=state.x, pPred=(state.p??1)+q, gain=pPred/(pPred+r);
    let x=pred+gain*(y-pred), p=(1-gain)*pPred;
    if(kind==='adaptive'){
      const z=Math.abs(y-x)/Math.sqrt(Math.max(EPS,p+r));
      if(z>2.4-a*.5){ x=.65*y+.35*x; p=Math.min(2,p+r*.35); state.change=true; }
      else state.change=false;
    }
    return {...state,x,p,gain};
  }
  if(kind==='changepoint'){
    const prev=state.x??y, scale=Math.sqrt((state.var??1)+sigma*sigma+EPS), z=Math.abs(y-prev)/scale;
    const threshold=3.0-1.2*a;
    const change=z>threshold;
    const eff=change?Math.max(.65,a):a;
    const x=eff*y+(1-eff)*prev;
    const resid=y-x, v=.9*(state.var??1)+.1*resid*resid;
    return {...state,x,var:v,change};
  }
  const prev=state.x??y, x=a*y+(1-a)*prev;
  return {...state,x,var:.9*(state.var??1)+.1*(y-x)*(y-x),change:false};
}
function confidenceFor(estState,estimate,threshold,sigma,method='residual_common_v1'){
  if(method==='residual_common_v1'){const variance=Math.max(sigma*sigma,estState.predictionVariance??sigma*sigma,EPS);return clamp(.5+.5*(1-Math.exp(-Math.abs(estimate-threshold)/Math.sqrt(variance))),.5,.999);}

  const distance=Math.abs(estimate-threshold);
  const uncertainty=Math.sqrt(Math.max(EPS,estState.p??estState.var??sigma*sigma));
  return clamp(.5+.5*(1-Math.exp(-distance/(uncertainty+.12))),.5,.999);
}
function reviewerDecision(rng,aiStop,shouldStop,confidence,reviewer,delayBase,delayMult,participantEffect=0){
  const strata=Array.isArray(reviewer?.by_confidence)?reviewer.by_confidence:[];
  const stratum=strata.length?strata.reduce((best,x)=>Math.abs(Number(x.confidence)-confidence)<Math.abs(Number(best.confidence)-confidence)?x:best,strata[0]):null;
  const falseAccept=Number(stratum?.false_accept_rate??reviewer?.false_accept_rate??.08);
  const correctOverride=Number(stratum?.correct_override_rate??reviewer?.correct_override_rate??.78);
  const unnecessaryOverride=Number(stratum?.unnecessary_override_rate??reviewer?.unnecessary_override_rate??Math.min(.18,falseAccept*.5));
  const shift=p=>{p=clamp(Number(p),.001,.999);const z=Math.log(p/(1-p))+participantEffect;return 1/(1+Math.exp(-z));};
  let finalStop=aiStop;
  if(aiStop!==shouldStop){ if(rng()<shift(correctOverride)) finalStop=shouldStop; }
  else if(rng()<shift(unnecessaryOverride)) finalStop=!aiStop;
  const base=Math.max(0,Number(delayBase||0))+Math.max(0,Number(reviewer?.mean_delay||0))/86400;
  return {finalStop,delay:Math.max(0,base*delayMult*(.85+.3*rng())),falseAccept,correctOverride};
}
function simulateEpisode(c,constraints,rng,scenario,reviewer,config,reviewRng=mulberry32(20261002)){
  const horizon=Number(config.horizon||24), tau=Math.max(0,Math.round(c.tau||0));
  const threshold=Number(scenario.risk_threshold_override??config.risk_threshold??.68), latentThreshold=Math.log(threshold/(1-threshold));
  const history=[], est={x:0,p:1,var:Math.max(c.sigma*c.sigma,scenario.process_noise**2),predictionVariance:Math.max(c.sigma*c.sigma,scenario.process_noise**2),change:false};
  const confidenceBins=Array.from({length:10},()=>({n:0,sum:0,correct:0}));
  let state=randn(rng)*.25, reviewN=0, rtSum=0, fp=0,fn=0, decisions=0, totalLoss=0, adjustmentN=0;
  let rollingErrors=0, safeMode=0;
  // delay_mode='queue_v1': 검토가 필요한 결정은 승인지연 d(일, 시나리오 배율 반영) 뒤에야 집행되고, 그 사이에는 직전 집행 결정이 유지된다(hold-last).
  // 'legacy_v0'은 과거 사이클 재현용: d가 손실의 가산항으로만 들어간다.
  const queueMode=(config.delay_mode||'queue_v1')==='queue_v1', approvalQueue=[]; let inForce=false;const participantEffect=Number(reviewer?.participant_accept_sd||0)>0?randn(reviewRng)*Number(reviewer.participant_accept_sd):0;
  for(let t=0;t<horizon;t++){
    const shifted=scenario.shift_time>=0 && t>=scenario.shift_time ? scenario.shift_magnitude : 0;
    const digitalSens=Number(config.empirical?.params?.outflow_digital_sensitivity?.value??0.35),empiricalPulse=Number(scenario.empirical_outflow||0)*(1+digitalSens*Number(scenario.digital||0));
    state=scenario.rho*state + scenario.drift + empiricalPulse + shifted*(t===scenario.shift_time?1:.02) + randn(rng)*scenario.process_noise*scenario.volatility;
    const obs=state+randn(rng)*c.sigma*scenario.volatility;
    history.push(obs);
    const delayed=history[Math.max(0,history.length-1-tau)];
    // Identical one-step predictive residual semantics for every estimator; no latent labels.
    const residual=delayed-est.x,previousVariance=est.predictionVariance;
    const es=estimatorStep(c.estimator||'ema',est,delayed,c.alpha,c.sigma);
    Object.assign(est,es);
    const estimate=est.x;let confidence=confidenceFor(est,estimate,latentThreshold,c.sigma,config.confidence_method||'residual_common_v1');
    est.predictionVariance=.9*previousVariance+.1*residual*residual;
    const shouldStop=logistic(state)>threshold;
    const aiStop=estimate>latentThreshold;
    // Only pure offline audit callers can request perfect-label foresight; configFrom never enables it.
    if(config.audit_perfect_label===true)confidence=aiStop===shouldStop?1:0;
    const bin=confidenceBins[Math.min(9,Math.floor(confidence*10))];bin.n++;bin.sum+=confidence;bin.correct+=aiStop===shouldStop?1:0;
    const K=Number(c.authority_k);
    let needsReview=K===0 || K===1 || safeMode>0;
    if(K===2) needsReview=needsReview || confidence<Number(config.k2_confidence||.84);
    if(K>=3) needsReview=needsReview || confidence<Number(config.k3_confidence||.67);
    let finalStop=aiStop, decisionDelay=Number(config.autonomous_delay_days??.02);
    if(needsReview){
      reviewN++;
      const hr=reviewerDecision(reviewRng,aiStop,shouldStop,confidence,reviewer,c.delay_d,scenario.delay_multiplier);
      finalStop=hr.finalStop; decisionDelay=hr.delay;
    }
    if(queueMode){
      while(approvalQueue.length&&approvalQueue[0].at<=t) inForce=approvalQueue.shift().stop;
      if(!needsReview) inForce=aiStop;                                        // 자동집행은 즉시 적용
      else {
        const lag=Math.max(0,Math.round(Number(c.delay_d||0)*Number(scenario.delay_multiplier||1)));
        if(lag===0) inForce=finalStop; else approvalQueue.push({at:t+lag,stop:finalStop});   // 대기 결정은 폐기되지 않고 도착 시 낡은 상태 그대로 집행(stale approval)
      }
      finalStop=inForce;                                                      // 이후 FP/FN/손실은 '실제 집행된' 결정으로 평가
    }
    if(finalStop&&!shouldStop) fp++;
    if(!finalStop&&shouldStop) fn++;
    const wrong=finalStop!==shouldStop;
    const recAlpha=Number(config.recovery_alpha??.18);
    rollingErrors=(1-recAlpha)*rollingErrors+recAlpha*(wrong?1:0);
    const riskExcess=Math.max(0,logistic(state)-threshold);
    const lossCal=config.empirical?.loss||{};
    const cFP=Number(lossCal.c_fp??.0592)*Number(scenario.c_fp_multiplier??1), cFN=Number(lossCal.c_fn??.0832)*Number(scenario.c_fn_multiplier??1), T=Number(lossCal.horizon??horizon);
    // FP = 정지 오판(정상지급 차단), FN = 정지 누락(부정지급·유출).
    // 비용은 n=81 위기 패널의 실패/비실패 집단 평균 peak_outflow로 보정한다.
    const decisionLoss=(finalStop&&!shouldStop?cFP:0)+(!finalStop&&shouldStop?cFN:0);
    const exposure=(!finalStop?cFN*riskExcess*(1+(queueMode?0:decisionDelay/Math.max(1,T))):0);
    const delayLoss=queueMode?0:(decisionDelay/Math.max(1,T))*(finalStop?cFP:cFN);   // queue 모드에서는 지연이 집행 시점 이동으로 이미 반영됨(이중계산 방지)
    let loss=(decisionLoss+exposure+delayLoss)*Number(scenario.loss_multiplier||1);
    if(needsReview) loss+=Number(lossCal.review_cost??cFP/Math.max(1,T));
    totalLoss+=loss; rtSum+=decisionDelay; decisions++;
    // Recovery: error EWMA(recAlpha)는 설계 파라미터이며, 비용 스케일만 n=81 패널에서 보정한다.
    if((rollingErrors>Number(c.adjust_m)||exposure>Number(c.recovery_w)) && safeMode===0){
      safeMode=Math.max(1,Math.round(2+3*c.recovery_w)); adjustmentN++; totalLoss+=Number(lossCal.adjustment_cost??cFN/Math.max(1,T));
    }
    if(safeMode>0) safeMode--;
  }
  const episodeLoss=totalLoss/Math.max(1,horizon);
  const recoveryTime=rtSum/Math.max(1,decisions), burden=reviewN/Math.max(1,decisions), norm=Math.max(EPS,Number(config.empirical?.loss?.normalization??constraints.loss_max??1));
  // 목적함수는 임의 가중치를 제거하고 각 항을 경험적 손실 스케일과 T로 무차원화한다.
  const objective=episodeLoss/norm + burden + recoveryTime/Math.max(1,horizon) + adjustmentN/Math.max(1,horizon);
  return {episodeLoss,lossExceeded:episodeLoss>constraints.loss_max,fp,fn,decisions,reviewN,recoveryTime,adjustmentN,objective,confidenceBins};
}
function emptyAgg(){ return {episodes:0,lossExceed:0,fp:0,fn:0,decisions:0,reviewN:0,rtSum:0,rtSq:0,lossSum:0,lossSq:0,objSum:0,objSq:0,adjustments:0,confidenceBins:Array.from({length:10},()=>({n:0,sum:0,correct:0})),scenarios:{},groups:{}}; }
function addEpisodeStats(a,e,key){
  for(let i=0;i<10;i++)for(const k of ['n','sum','correct'])a.confidenceBins[i][k]+=Number(e.confidenceBins?.[i]?.[k]||0);
  a.episodes++; a.lossExceed+=e.lossExceeded?1:0; a.fp+=e.fp; a.fn+=e.fn; a.decisions+=e.decisions; a.reviewN+=e.reviewN;
  a.rtSum+=e.recoveryTime; a.rtSq+=e.recoveryTime*e.recoveryTime; a.lossSum+=e.episodeLoss; a.lossSq+=e.episodeLoss*e.episodeLoss; a.objSum+=e.objective; a.objSq+=e.objective*e.objective; a.adjustments+=e.adjustmentN;
  const s=a.scenarios[key]??={n:0,objSum:0,lossSum:0,violations:0}; s.n++; s.objSum+=e.objective; s.lossSum+=e.episodeLoss; s.violations+=e.lossExceeded?1:0;
}
function addEpisode(a,e,key,group=null){
  addEpisodeStats(a,e,key);
  if(group){const g=a.groups[group]??=emptyAgg();addEpisodeStats(g,e,key);}
}
function mergeAgg(target,src){
  for(let i=0;i<10;i++)for(const k of ['n','sum','correct'])target.confidenceBins[i][k]+=Number(src.confidenceBins?.[i]?.[k]||0);
  for(const k of ['episodes','lossExceed','fp','fn','decisions','reviewN','rtSum','rtSq','lossSum','lossSq','objSum','objSq','adjustments']) target[k]+=Number(src[k]||0);
  for(const [k,v] of Object.entries(src.scenarios||{})){ const s=target.scenarios[k]??={n:0,objSum:0,lossSum:0,violations:0}; for(const f of ['n','objSum','lossSum','violations']) s[f]+=Number(v[f]||0); }
  for(const [k,v] of Object.entries(src.groups||{})){const g=target.groups[k]??=emptyAgg();mergeAgg(g,v);}
  return target;
}
function finalizeAgg(a,constraints,confidence=.95,inference={},includeGroups=true){
  const nominalZ=confidence>=.99?2.576:confidence>=.95?1.96:1.645;
  const method=inference.method||'none',familySize=Math.max(1,Number(inference.familySize||1)),constraintCount=Object.keys(PROB_CONSTRAINTS).length+Object.keys(MEAN_CONSTRAINTS).length+(Number.isFinite(Number(constraints.loss_max??constraints.loss_mean_max))?1:0);
  const alpha=1-confidence,tests=Math.max(1,familySize*constraintCount),adjust=method==='bonferroni'&&inference.adjust===true;
  const z=adjust?normInv(1-alpha/(2*tests)):nominalZ;
  const nE=Math.max(1,a.episodes), nD=Math.max(1,a.decisions);
  const metrics={
    n:a.episodes,decisions:a.decisions,loss_mean:a.lossSum/nE,loss_exceed_rate:a.lossExceed/nE,
    fp_rate:a.fp/nD,fn_rate:a.fn/nD,review_burden:a.reviewN/nD,recovery_time:a.rtSum/nE,
    objective_score:a.objSum/nE,adjustment_rate:a.adjustments/nE
  };
  const lossSd=sampleSd(a.lossSum,a.lossSq,a.episodes), rtSd=sampleSd(a.rtSum,a.rtSq,a.episodes);
  const burdenCI=wilson(a.reviewN,a.decisions,z), lossCI=wilson(a.lossExceed,a.episodes,z), fpCI=wilson(a.fp,a.decisions,z), fnCI=wilson(a.fn,a.decisions,z);
  const rtCI=normalCI(metrics.recovery_time,rtSd,a.episodes,z);
  const ci={loss_mean:normalCI(metrics.loss_mean,lossSd,a.episodes,z),loss_exceed_rate:lossCI,fp_rate:fpCI,fn_rate:fnCI,review_burden:burdenCI,recovery_time:rtCI};
  const evals=[];
  const lossLimit=Number(constraints.loss_max??constraints.loss_mean_max);
  if(Number.isFinite(lossLimit))evals.push({metric:'loss_mean',limit:lossLimit,...ci.loss_mean,mean:metrics.loss_mean});
  for(const [metric,limitKey] of Object.entries(PROB_CONSTRAINTS)){ const q=ci[metric], lim=Number(constraints[limitKey]); evals.push({metric,limit:lim,lo:q.lo,hi:q.hi,mean:metrics[metric]}); }
  for(const [metric,limitKey] of Object.entries(MEAN_CONSTRAINTS)){ const q=ci[metric], lim=Number(constraints[limitKey]); evals.push({metric,limit:lim,lo:q.lo,hi:q.hi,mean:metrics[metric]}); }
  const anyFail=evals.some(x=>x.lo>x.limit), allPass=evals.every(x=>x.hi<=x.limit);
  const classification=anyFail?'INFEASIBLE':allPass?'FEASIBLE':'UNRESOLVED';
  const normalizedDistances=evals.map(x=>Math.abs(x.mean-x.limit)/Math.max(.01,Math.abs(x.limit)));
  const boundaryScore=1/(.05+Math.min(...normalizedDistances));
  const scenario_scores=Object.fromEntries(Object.entries(a.scenarios).map(([k,v])=>[k,{n:v.n,objective:v.objSum/Math.max(1,v.n),loss_mean:v.lossSum/Math.max(1,v.n),loss_exceed_rate:v.violations/Math.max(1,v.n)}]));
  const validation_groups={};
  if(includeGroups)for(const [k,g] of Object.entries(a.groups||{}))validation_groups[k]=finalizeAgg(g,constraints,confidence,inference,false);
  const confidence_bins=(a.confidenceBins||[]).filter(b=>b.n).map(b=>({n:b.n,confidence:b.sum/b.n,accuracy:b.correct/b.n}));
  const calibration_ece=confidence_bins.reduce((s,b)=>s+b.n*Math.abs(b.confidence-b.accuracy),0)/nD;
  return {metrics,ci,confidence_audit:{bins:confidence_bins,ece:calibration_ece,scope:'diagnostic, not a calibration certificate'},classification,boundary_score:boundaryScore,constraints:evals,scenario_scores,validation_groups,inference:{method:adjust?'bonferroni':'nominal',nominal_confidence:confidence,family_size:familySize,constraint_count:constraintCount,simultaneous_tests:adjust?tests:constraintCount,z_critical:z},raw:a};
}
function deterministicSeed(projectId,candidateId,phase,cycle){ return hashString(`${projectId}|${candidateId}|${phase}|${cycle}|DCV-CDRS-v2`)&0x7fffffff; }
function applyNoninferiority(ev,candidate,baseline,margins){
 const comparisons=[['loss_mean',Number(margins.loss_relative_margin),true],['fn_rate',Number(margins.fn_absolute_margin),false],['fp_rate',Number(margins.fp_absolute_margin),false]].map(([metric,margin,relative])=>{
  const a=candidate.ci[metric],b=baseline.ci[metric],factor=relative?1+margin:1,limit=relative?0:margin;
  return {metric:'noninferiority_'+metric,limit,mean:candidate.metrics[metric]-factor*baseline.metrics[metric],lo:a.lo-factor*b.hi,hi:a.hi-factor*b.lo};
 });
 ev.noninferiority={baseline:'matched full-review K0; same estimator, delays, scenario and environment seed',margins,baseline_metrics:baseline.metrics,comparisons,scope:'Conservative simultaneous CI contrasts for the current independent batch; no post-hoc threshold selection'};
 ev.constraints.push(...comparisons);
 ev.classification=ev.constraints.some(x=>x.lo>x.limit)?'INFEASIBLE':ev.constraints.every(x=>x.hi<=x.limit)?'FEASIBLE':'UNRESOLVED';
 return ev;
}
function configFrom(def,env,cal){
  const b=def.content.benchmark||{}, v=def.content.validation||{};
  return {confidence_method:b.confidence_method||'residual_common_v1',delay_mode:b.delay_mode||'queue_v1',replication_mode:b.replication_mode||null,replication_seed_salt:b.replication_seed_salt||null,replication_scenario_salt:b.replication_scenario_salt||null,replication_scenario_mode:b.replication_scenario_mode||null,autonomous_delay_days:Number(b.autonomous_delay_days??.02),noninferiority:b.noninferiority||null,horizon:Number(b.horizon||cal.params.horizon_days?.value||90),risk_threshold:Number(b.risk_threshold||cal.params.stability_theta_korea?.value||.62),recovery_alpha:Number(b.recovery_alpha??.18),k2_confidence:Number(b.k2_confidence||.84),k3_confidence:Number(b.k3_confidence||.67),max_refinement:Number(v.max_refinement||3),max_confirmation:Number(v.max_confirmation??2),confidence:Number(def.content.constraints?.confidence||.95),familywise_confidence:Number(v.familywise_confidence||def.content.constraints?.confidence||.95),multiplicity_method:v.multiplicity_method||'bonferroni',family_size:Number(def.content.design?.max_candidates||128),exploration_n:Number(v.exploration_n||env.SIM_BATCH_SIZE||180),refinement_n:Number(v.refinement_n||env.SIM_BATCH_SIZE||240),confirmation_n:Number(v.confirmation_n||Math.max(300,Number(env.SIM_BATCH_SIZE||180))),robust_n:Number(v.robust_n||Math.max(300,Number(env.SIM_BATCH_SIZE||180))),empirical:cal};
}
function designDims(d){
  const dims=['sigma','tau','alpha','K','d','W','m'].map(k=>({k,vals:(d[k]&&d[k].length?d[k]:[0]).map(Number)}));
  const est=(d.estimators||ESTIMATORS).filter(x=>ESTIMATORS.includes(x));
  dims.push({k:'estimator',vals:est.length?est:['ema']});
  return dims;
}
function decodePoint(dims,idx){ const o={}; for(const {k,vals} of dims){ o[k]=vals[idx%vals.length]; idx=Math.floor(idx/vals.length); } return o; }
// CPU-light maximin: never materialises the full cartesian grid (tens of thousands of points).
// Draws a deterministic random pool, then greedy farthest-point selection with an incremental min-distance array.
export function sampleDesign(d,max,seed){
  const dims=designDims(d); const total=dims.reduce((a,x)=>a*x.vals.length,1);
  const pool=[], poolMult=2;
  if(total<=max*poolMult){ for(let i=0;i<total;i++) pool.push(decodePoint(dims,i)); }
  else{ const rng=mulberry32(seed), seen=new Set(), want=max*poolMult; while(pool.length<want){ const i=Math.floor(rng()*total); if(seen.has(i))continue; seen.add(i); pool.push(decodePoint(dims,i)); } }
  if(pool.length<=max) return pool;
  const nk=['sigma','tau','alpha','K','d','W','m'], range={};
  for(const k of nk){ const vs=dims.find(x=>x.k===k).vals; range[k]=[Math.min(...vs),Math.max(...vs)]; }
  const D=nk.length, N=pool.length, vec=new Float64Array(N*D), est=new Int8Array(N), ests=dims[7].vals;
  for(let i=0;i<N;i++){ for(let t=0;t<D;t++){ const k=nk[t]; vec[i*D+t]=(Number(pool[i][k])-range[k][0])/Math.max(EPS,range[k][1]-range[k][0]); } est[i]=ests.indexOf(pool[i].estimator); }
  const minD=new Float64Array(N).fill(Infinity), taken=new Uint8Array(N), chosen=[]; let cur=0;
  while(true){
    taken[cur]=1; chosen.push(pool[cur]); if(chosen.length>=max)break;
    let best=-1,bi=-1; const co=cur*D;
    for(let i=0;i<N;i++){ if(taken[i])continue; let s2=est[i]===est[cur]?0:1; const io=i*D; for(let t=0;t<D;t++){const z=vec[io+t]-vec[co+t]; s2+=z*z;} if(s2<minD[i])minD[i]=s2; if(minD[i]>best){best=minD[i];bi=i;} }
    cur=bi;
  }
  return chosen;
}

export function balancedFactorialDesign(d,max=192){
  const est=(d.estimators||ESTIMATORS).filter(x=>ESTIMATORS.includes(x));
  const alphas=(d.alpha&&d.alpha.length?d.alpha:[.15,.35,.55,.75]).map(Number);
  const ws=(d.W&&d.W.length?d.W:[.05,.12,.22]).map(Number);
  const core=[]; for(const estimator of est)for(const alpha of alphas)for(const W of ws)core.push({estimator,alpha,W});
  const sigma=(d.sigma?.length?d.sigma:[.03,.05,.10]).map(Number),tau=(d.tau?.length?d.tau:[0,1,2]).map(Number),delays=(d.d?.length?d.d:[0,1,2,4]).map(Number),ms=(d.m?.length?d.m:[.08,.15,.25]).map(Number);
  const ks=(d.K?.length?d.K:[2,3]).map(Number).filter(x=>x>=2); if(!ks.length)ks.push(2,3);
  const reps=Math.max(1,Math.min(4,Math.floor(Math.max(core.length,max)/core.length))),out=[];
  for(let b=0;b<reps;b++){
    const nuisance={sigma:sigma[b%sigma.length],tau:tau[b%tau.length],K:ks[b%ks.length],d:delays[b%delays.length],m:ms[b%ms.length]};
    for(const c of core)out.push({...nuisance,...c,base_id:`block_${b+1}`,role:'balanced_factorial'});
  }
  return out.slice(0,max);
}

// ---- orthogonal_balanced_v3 -------------------------------------------------
// 코어(추정기×α×W) 48셀을 완전교차로 R회 반복하고, nuisance(σ,τ,d,m,K)는 열 내 순열만 바꾸어(주변 균형 보존)
// 모든 요인쌍의 카이제곱 연관(교락)을 시드 고정 hill-climb로 최소화한다. v2의 '블록 4개' 방식은 σ·τ·m이 완전 동반이동했다.
function chiPair(a,b,la,lb,n){
  const t=Array.from({length:la},()=>new Array(lb).fill(0)); for(let i=0;i<n;i++)t[a[i]][b[i]]++;
  const ra=t.map(r=>r.reduce((x,y)=>x+y,0)), cb=Array.from({length:lb},(_,j)=>t.reduce((x,r)=>x+r[j],0));
  let chi=0; for(let i=0;i<la;i++)for(let j=0;j<lb;j++){const e=ra[i]*cb[j]/n; if(e>0)chi+=(t[i][j]-e)**2/e;} return chi;
}
export function designAudit(rows,factors=['estimator','alpha','W','sigma','tau','d','m','K']){
  const n=rows.length, levels={}, idx={};
  for(const f of factors){levels[f]=[...new Set(rows.map(r=>r[f]))].sort((x,y)=>x>y?1:-1); idx[f]=rows.map(r=>levels[f].indexOf(r[f]));}
  const marginals={}; for(const f of factors){marginals[f]={}; for(const v of levels[f])marginals[f][v]=rows.filter(r=>r[f]===v).length;}
  const pairs=[]; for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++){
    const f=factors[i],g=factors[j],la=levels[f].length,lb=levels[g].length,chi=chiPair(idx[f],idx[g],la,lb,n),k=Math.min(la,lb)-1;
    pairs.push({a:f,b:g,cramers_v:k>0?Math.sqrt(chi/(n*k)):0});
  }
  const cells=new Set(rows.map(r=>`${r.estimator}|${r.alpha}|${r.W}`));
  return {n,marginals,pairs,max_cramers_v:Math.max(0,...pairs.map(p=>p.cramers_v)),core_cells:cells.size,core_reps:rows.length/Math.max(1,cells.size)};
}
export function orthogonalBalancedDesign(d,max=192,seed=20261004,iterations=30000){
  const est=(d.estimators||ESTIMATORS).filter(x=>ESTIMATORS.includes(x)), alphas=(d.alpha?.length?d.alpha:[.15,.35,.55,.75]).map(Number), ws=(d.W?.length?d.W:[.05,.12,.22]).map(Number);
  const sig=(d.sigma?.length?d.sigma:[.03,.05,.10]).map(Number), tau=(d.tau?.length?d.tau:[0,1,2]).map(Number), dd=(d.d?.length?d.d:[0,1,2,4]).map(Number), ms=(d.m?.length?d.m:[.08,.15,.25]).map(Number);
  const ks=(d.K?.length?d.K:[2,3]).map(Number).filter(x=>x>=2); if(!ks.length)ks.push(2,3);
  const core=[]; for(const e of est)for(const a of alphas)for(const W of ws)core.push({estimator:e,alpha:a,W});
  const R=Math.max(1,Math.floor(max/core.length)), n=core.length*R, rng=mulberry32(seed);
  const rows=[]; for(let r=0;r<R;r++)core.forEach((c,ci)=>rows.push({...c,base_id:`cell_${String(ci+1).padStart(2,'0')}_r${r+1}`,role:'balanced_factorial'}));
  const nuis={sigma:sig,tau,d:dd,m:ms,K:ks}, names=Object.keys(nuis), cols={};
  const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
  for(const f of names){cols[f]=shuffle(Array.from({length:n},(_,i)=>i%nuis[f].length));}   // 주변 분포는 (n이 배수일 때) 정확히 균형
  const fixed={estimator:rows.map(r=>est.indexOf(r.estimator)),alpha:rows.map(r=>alphas.indexOf(r.alpha)),W:rows.map(r=>ws.indexOf(r.W))}, fixedL={estimator:est.length,alpha:alphas.length,W:ws.length};
  const all=()=>({...fixed,...cols}), L=f=>fixedL[f]??nuis[f].length, facs=[...Object.keys(fixed),...names];
  const pairCost=(A,f,g)=>chiPair(A[f],A[g],L(f),L(g),n);
  const total=A=>{let s=0;for(let i=0;i<facs.length;i++)for(let j=i+1;j<facs.length;j++)s+=pairCost(A,facs[i],facs[j]);return s;};
  const A=all(); let cost=total(A);
  for(let it=0;it<iterations&&cost>1e-9;it++){
    const f=names[Math.floor(rng()*names.length)], i=Math.floor(rng()*n), j=Math.floor(rng()*n); if(A[f][i]===A[f][j])continue;
    let before=0; for(const g of facs)if(g!==f)before+=pairCost(A,f,g);
    [A[f][i],A[f][j]]=[A[f][j],A[f][i]];
    let after=0; for(const g of facs)if(g!==f)after+=pairCost(A,f,g);
    if(after<=before)cost+=after-before; else [A[f][i],A[f][j]]=[A[f][j],A[f][i]];
  }
  rows.forEach((r,i)=>{r.sigma=sig[A.sigma[i]];r.tau=tau[A.tau[i]];r.d=dd[A.d[i]];r.m=ms[A.m[i]];r.K=ks[A.K[i]];});
  return rows.slice(0,max);
}

export async function seedCandidates(env,projectId){
  const proj=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]); const cycle=Number(proj?.research_cycle||1);
  const existing=await one(env.DB,`SELECT COUNT(*) n FROM design_candidates WHERE project_id=? AND research_cycle=?`,[projectId,cycle]); if(Number(existing?.n||0)>0){
    // 주기적 수집(collect→measure→seed_candidates)마다 buildProtocol(후보 128행+에폭+계수)을 다시 돌리던 경로.
    // 동결된 프로토콜이 이미 있으면 재구성하지 않는다(무결성은 compute_candidate 에서 검증).
    const frozen=await one(env.DB,`SELECT 1 x FROM research_protocols WHERE project_id=? AND research_cycle=? LIMIT 1`,[projectId,cycle]);
    if(!frozen) await ensureFrozenProtocol(env,projectId);
    await enqueueOnce(env,projectId,'advance_project',{},5);
    return{created:0,resume_requested:true};
  }
  const def=await latestDefinition(env,projectId); if(!def)throw new Error('definition_missing'); const d={...(def.content.design||{})};
  const mr=await one(env.DB,`SELECT metrics_json FROM measurements WHERE project_id=? ORDER BY measured_at DESC LIMIT 1`,[projectId]);
  const mm=safeJson(mr?.metrics_json,{}),op=mm.operational||{},observedSigma=Number(mm?.pooled?.empirical_sigma);
  const robustGrid=(v,min=0,max=999,integer=false)=>{const a=[.6,1,1.4].map(m=>clamp(v*m,min,max)).map(x=>integer?Math.round(x):Number(x.toFixed(4)));return [...new Set(a)];};
  if(d.grid_source==='operational'&&Number.isFinite(observedSigma)&&observedSigma>0&&Number(mm.numeric_observations||0)>=30)d.sigma=robustGrid(observedSigma,.005,.50,false);
  if(d.grid_source==='operational'&&op.data_latency_days!=null&&Number.isFinite(Number(op.data_latency_days)))d.tau=robustGrid(Number(op.data_latency_days),0,30,true);
  if(d.grid_source==='operational'&&op.approval_delay_days!=null&&Number.isFinite(Number(op.approval_delay_days)))d.d=robustGrid(Number(op.approval_delay_days),0,30,false);
  const maxCandidates=Number(d.max_candidates||192); const combos=Array.isArray(d.candidate_rows)?d.candidate_rows:(d.design_mode==='orthogonal_balanced_v3'?orthogonalBalancedDesign(d,maxCandidates,hashString(`${projectId}:orth`)&0x7fffffff):d.design_mode==='balanced_factorial_v2'?balancedFactorialDesign(d,maxCandidates):sampleDesign(d,maxCandidates,hashString(`${projectId}:design`))); const now=nowIso();
  const rows=[]; for(const x of combos){ const vec={estimator:x.estimator,sigma:Number(x.sigma),tau:Number(x.tau),alpha:Number(x.alpha),K:Number(x.K),d:Number(x.d),W:Number(x.W),m:Number(x.m)}; const design_key=await sha256Hex(stableStringify(vec)); rows.push({...x,id:uid('cand'),design_key}); } const candIds=rows.map(x=>x.id);
  const stmts=[env.DB.prepare(`INSERT INTO design_candidates(id,project_id,sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,status,estimator,evidence_status,created_at,updated_at,research_cycle,base_id,candidate_role,pair_seed_key,design_key)
   SELECT json_extract(value,'$.id'),?,json_extract(value,'$.sigma'),json_extract(value,'$.tau'),json_extract(value,'$.alpha'),json_extract(value,'$.K'),json_extract(value,'$.d'),json_extract(value,'$.W'),json_extract(value,'$.m'),'pending',json_extract(value,'$.estimator'),'pending',?,?,?,json_extract(value,'$.base_id'),COALESCE(json_extract(value,'$.role'),'exploratory'),json_extract(value,'$.base_id'),json_extract(value,'$.design_key') FROM json_each(?)`).bind(projectId,now,now,cycle,JSON.stringify(rows))];
  if(rows.length)await env.DB.batch([...stmts,env.DB.prepare('UPDATE projects SET candidate_count=? WHERE id=?').bind(rows.length,projectId)]);
  const frozenProtocol=await ensureFrozenProtocol(env,projectId);
  if(d.design_mode==='independent_replication_v1')try{await run(env.DB,`UPDATE independent_replications SET replication_protocol_hash=? WHERE project_id=? AND replication_cycle=?`,[frozenProtocol?.protocol_hash||null,projectId,cycle]);}catch{}
  const initialPhase=d.design_mode==='independent_replication_v1'?'confirmation':'exploration';
  await enqueueMany(env,projectId,'compute_candidate',candIds.map(id=>({candidate_id:id,phase:initialPhase,cycle:0})),40);
  const method=d.design_mode==='independent_replication_v1'?'independent_replication_v1':Array.isArray(d.candidate_rows)?'preregistered_paired_csv':(d.design_mode==='orthogonal_balanced_v3'?'orthogonal_balanced_v3':d.design_mode==='balanced_factorial_v2'?'balanced_factorial_v2':'maximin');
  await audit(env,projectId,'agent','cdrs.seed','project',projectId,{created:rows.length,method,initial_phase:initialPhase,estimators:d.estimators||ESTIMATORS,empirical_grid:{sigma:d.sigma,tau:d.tau,d:d.d},source:{sigma:Number.isFinite(observedSigma)&&Number(mm.numeric_observations||0)>=30?'external_observations':'paper/default',tau:d.grid_source==='operational'&&op.data_latency_days!=null&&Number.isFinite(Number(op.data_latency_days))?'operational_logs':'declared_design',approval_delay:d.grid_source==='operational'&&op.approval_delay_days!=null&&Number.isFinite(Number(op.approval_delay_days))?'operational_logs':'declared_design'}}); return{created:rows.length,initial_phase:initialPhase};
}
async function loadScenarios(env,projectId,phase,cal,replicationSnapshot=null){
  if(phase==='historical'){
    const eps=replicationSnapshot?.episodes?.length?replicationSnapshot.episodes.filter(r=>r.peak_outflow!=null&&r.concentration!=null&&r.severity!=null):await cached(env,projectId,'scn:episodes',()=>all(env.DB,`SELECT * FROM empirical_episodes WHERE project_id=? AND peak_outflow IS NOT NULL AND concentration IS NOT NULL AND severity IS NOT NULL ORDER BY year,episode_name`,[projectId]));
    if(eps.length){const full=eps.length>=Number(cal.profile.panel_n||81);return {scenarios:eps.map(r=>({...empiricalScenarioFromEpisode(r,cal),validation_group:'Historical'})),source:replicationSnapshot?'replication_snapshot_empirical_episodes':(full?'empirical_episodes_full':'empirical_episodes_partial'),empirical_ready:full,episode_n:eps.length};}
    const rows=await cached(env,projectId,'scn:user-historical',()=>all(env.DB,`SELECT * FROM scenarios WHERE project_id=? AND scenario_type='historical' ORDER BY name`,[projectId]));
    if(rows.length)return {scenarios:rows.map(r=>({...scenarioFromRow(r,cal),validation_group:'Historical'})),source:'user_historical_scenarios',empirical_ready:false,episode_n:0};
    return {scenarios:syntheticScenarios(cal),source:'published_summary_anchor',empirical_ready:false,episode_n:0};
  }
  if(phase==='stress'){
    const rows=replicationSnapshot?.scenario_rows?.length?replicationSnapshot.scenario_rows.filter(r=>r.scenario_type==='adversarial'):await cached(env,projectId,'scn:user-adversarial',()=>all(env.DB,`SELECT * FROM scenarios WHERE project_id=? AND scenario_type='adversarial' ORDER BY name`,[projectId]));
    if(rows.length)return {scenarios:rows.map(r=>scenarioFromRow(r,cal)),source:replicationSnapshot?'replication_snapshot_adversarial_scenarios':'user_adversarial_scenarios',empirical_ready:true,episode_n:rows.length};
    const base=paperStressScenarios(cal),boot=calibrationUncertaintyScenarios(cal),loss=lossProxyScenarios(cal),official=replicationSnapshot?[]:await officialValidationScenarios(env,projectId,cal),scenarios=[...base,...boot,...loss,...official];
    return {scenarios,source:replicationSnapshot?'replication_snapshot_generated_stress':`paper_wide_40pct_grid+calibration_uncertainty+loss_proxy_sensitivity${official.length?'+official_external_validation':''}`,empirical_ready:true,episode_n:scenarios.length,official_scenarios:official.length};
  }
  return {scenarios:syntheticScenarios(cal),source:'published_summary_anchor',empirical_ready:false,episode_n:0};
}
function replicationHoldoutScenarios(scenarios,salt){
  if(!salt)return scenarios;
  return scenarios.map((sc,i)=>{
    const rng=mulberry32(hashString(`${salt}|${sc.key}|${i}|holdout-v1`)&0x7fffffff);
    const centered=()=>rng()*2-1, mult=(width)=>1+width*centered();
    const severity=clamp(Number(sc.severity??.75)*mult(.08),0,1), concentration=clamp(Number(sc.concentration??.75)*mult(.06),0,1), digital=clamp(Number(sc.digital??.5)*mult(.06),0,1), empirical_outflow=clamp(Number(sc.empirical_outflow??0)*mult(.08),0,.95);
    return {...sc,key:`rep_${i}_${String(sc.key||'scenario')}`,name:`Independent holdout: ${sc.name||sc.key||i+1}`,severity,concentration,digital,empirical_outflow,volatility:Math.max(.01,Number(sc.volatility??1)*mult(.08)),delay_multiplier:Math.max(.1,Number(sc.delay_multiplier??1)*mult(.08)),loss_multiplier:Math.max(.1,Number(sc.loss_multiplier??1)*mult(.08)),rho:clamp(Number(sc.rho??.82)+.03*centered(),-.99,.99),process_noise:Math.max(.001,Number(sc.process_noise??.03)*mult(.10)),shift_magnitude:Math.max(0,Number(sc.shift_magnitude??0)*mult(.10)),provenance:`${sc.provenance||'synthetic'}+independent_holdout_v1`,validation_group:'Independent replication'};
  });
}

async function priorAggregate(env,candidateId,phase){
  let phases=phase==='refinement'?['exploration','refinement']:[phase];
  if(phase==='confirmation')phases=['confirmation'];
  const marks=phases.map(()=>'?').join(','); const rows=await all(env.DB,`SELECT result_json FROM simulation_runs WHERE candidate_id=? AND phase IN (${marks}) ORDER BY created_at`,[candidateId,...phases]);
  const a=emptyAgg(); for(const r of rows){const j=safeJson(r.result_json,{});if(j.raw)mergeAgg(a,j.raw);} return a;
}
function nForPhase(config,phase){ if(phase==='exploration')return config.exploration_n;if(phase==='refinement')return config.refinement_n;if(phase==='confirmation')return config.confirmation_n;return config.robust_n; }
export async function computeCandidate(env,projectId,candidateId,phase='exploration',cycle=0){
  if(['github-actions','hybrid'].includes(env.COMPUTE_EXECUTOR)&&env.EXTERNAL_RUNTIME!=='github-actions')throw new Error('compute_requires_github_actions');
  const c=await one(env.DB,`SELECT * FROM design_candidates WHERE id=? AND project_id=?`,[candidateId,projectId]);if(!c)throw new Error('candidate_not_found');
  const projectMeta=await cached(env,projectId,'project:compute-meta',()=>one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]),30_000);const projectCycle=Number(projectMeta?.research_cycle||1),projectRev=Number(projectMeta?.evidence_revision||0);if(Number(c.research_cycle||1)!==projectCycle)throw new Error('candidate_superseded_by_new_cycle');
  const protocolAttestation=await assertProtocolIntegrity(env,projectId,{cycle:projectCycle});
  const liveDef=await latestDefinition(env,projectId);if(!liveDef)throw new Error('definition_missing');
  const frozenExec=protocolAttestation?.protocol?.execution_config;
  // Runtime computation is bound to the frozen protocol snapshot. latestDefinition is only a
  // compatibility fallback for protocols created before DCV-PROTOCOL-1.3 (those are normally
  // rolled into a fresh cycle by the integrity guard above).
  const def=frozenExec?{...liveDef,content:{...liveDef.content,...frozenExec}}:liveDef;
  const constraints=def.content.constraints,replicationMode=String(def.content.benchmark?.replication_mode||'')==='independent_replication_v1';let replicationSnapshot=null,cal;
  if(replicationMode){const rr=await one(env.DB,`SELECT locked_empirical_json,locked_scenarios_json FROM independent_replications WHERE project_id=? AND replication_cycle=? LIMIT 1`,[projectId,projectCycle]);if(!rr)throw new Error('replication_snapshot_missing');const e=safeJson(rr.locked_empirical_json,{}),q=safeJson(rr.locked_scenarios_json,{});cal=e.calibration;if(!cal)throw new Error('replication_calibration_snapshot_missing');replicationSnapshot={episodes:Array.isArray(e.episodes)?e.episodes:[],scenario_rows:Array.isArray(q.rows)?q.rows:[]};}else cal=await loadEmpiricalCalibration(env,projectId);const config=configFrom(def,env,cal);
  const degradedReviewer={false_accept_rate:.25,correct_override_rate:.60,unnecessary_override_rate:.20,participant_accept_sd:.50,mean_delay:0,source:'preregistered_degraded_reviewer_v1'};
  const key=`reviewer:latest:${projectCycle}:${projectRev}`;const rm=await cached(env,projectId,key,()=>one(env.DB,`SELECT model_json FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? ORDER BY version DESC LIMIT 1`,[projectId,projectCycle,projectRev]));const fittedReviewer=rm?safeJson(rm.model_json,{}):null;
  // Selection is no longer performed under an ideal reviewer. Before a qualified human model exists, a preregistered degraded-reviewer condition is used; once fitted, the current-revision human model is used in every phase.
  let reviewer=fittedReviewer||degradedReviewer;
  const scenarioPack=await loadScenarios(env,projectId,phase==='recompute'?'confirmation':phase,cal,replicationSnapshot); const scenarios=(config.replication_mode==='independent_replication_v1'&&['confirmation','recompute'].includes(phase)&&config.replication_scenario_mode==='deterministic_holdout_perturbation_v1')?replicationHoldoutScenarios(scenarioPack.scenarios,config.replication_scenario_salt):scenarioPack.scenarios; const seedNamespace=config.replication_mode==='independent_replication_v1'?`${projectId}|replication|${config.replication_seed_salt||'unsalted'}`:projectId; const seed=deterministicSeed(seedNamespace,c.pair_seed_key||candidateId,phase,cycle),rng=mulberry32(seed),n=nForPhase(config,phase);
  const id=`sim_unit_${candidateId}_${phase}_${cycle}_${phase==='recompute'?projectRev:'protocol'}`,saved=await one(env.DB,`SELECT result_json FROM simulation_runs WHERE id=?`,[id]);
  const batch=emptyAgg(),baseline=emptyAgg();if(!saved)for(let i=0;i<n;i++){const sc=scenarios[i%scenarios.length],episodeSeed=hashString(seed+'|'+i);addEpisode(batch,simulateEpisode(c,constraints,mulberry32(episodeSeed),sc,reviewer,config,mulberry32(episodeSeed^0x5a5a)),sc.key,sc.validation_group||null);if(config.noninferiority)addEpisode(baseline,simulateEpisode({...c,authority_k:0},constraints,mulberry32(episodeSeed),sc,reviewer,config,mulberry32(episodeSeed^0x5a5a)),sc.key,sc.validation_group||null);}
  let combined=batch; if(!saved&&['refinement','confirmation'].includes(phase)){const prior=await priorAggregate(env,candidateId,phase);combined=mergeAgg(prior,batch);}
  const confirmatory=['confirmation','historical','stress','recompute'].includes(phase);
  const ev=saved?safeJson(saved.result_json,{}):finalizeAgg(combined,constraints,confirmatory?config.familywise_confidence:config.confidence,{method:config.multiplicity_method,familySize:config.family_size*(config.noninferiority?2:1),adjust:confirmatory});
  if(config.noninferiority&&!saved){const base=finalizeAgg(baseline,constraints,config.familywise_confidence,{method:'bonferroni',familySize:config.family_size*2,adjust:true});applyNoninferiority(ev,finalizeAgg(batch,constraints,config.familywise_confidence,{method:'bonferroni',familySize:config.family_size*2,adjust:true}),base,config.noninferiority);}
  const m=ev.metrics;
  const currentScope=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);
  if(Number(currentScope?.research_cycle||1)!==projectCycle||Number(currentScope?.evidence_revision||0)!==projectRev)throw new Error('compute_scope_changed_during_run');
  const resultHash=saved?ev.result_hash:await sha256Hex(stableStringify({seed,phase,cycle,projectRev,raw:batch,metrics:m}));
  await run(env.DB,`INSERT OR IGNORE INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,loss_mean,loss_exceed_rate,fp_rate,fn_rate,review_burden,recovery_time,regret,result_json,created_at,evidence_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,projectId,candidateId,phase,seed,n,m.loss_mean,m.loss_exceed_rate,m.fp_rate,m.fn_rate,m.review_burden,m.recovery_time,null,JSON.stringify({...ev,result_hash:resultHash,raw:saved?ev.raw:batch,cycle,runner_code_revision:env.RUNNER_CODE_REVISION||null,engine_version:ENGINE_VERSION,delay_mode:config.delay_mode,confidence_method:config.confidence_method,candidate_role:c.candidate_role,reviewer_source:fittedReviewer?'current_revision_human_model':'preregistered_degraded_reviewer_v1',estimator:c.estimator,reviewer_used:!!reviewer,scenario_source:config.replication_mode==='independent_replication_v1'&&['confirmation','recompute'].includes(phase)?`${scenarioPack.source}+independent_holdout_v1`:scenarioPack.source,replication_mode:config.replication_mode||null,replication_seed_namespace:config.replication_mode==='independent_replication_v1'?'independent':null,replication_scenario_mode:config.replication_scenario_mode||null,protocol_hash:protocolAttestation?.protocol_hash||null,protocol_definition_version:protocolAttestation?.definition_version??null,protocol_attested_at_run:true,empirical_ready:scenarioPack.empirical_ready,empirical_episode_n:scenarioPack.episode_n,empirical_profile:cal.profile.version}),nowIso(),projectRev]);
  await run(env.DB,`INSERT OR IGNORE INTO candidate_evidence(id,project_id,candidate_id,phase,cycle,classification,boundary_score,metrics_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,[`evidence_${id}`,projectId,candidateId,phase,cycle,ev.classification,ev.boundary_score,JSON.stringify(ev),nowIso()]);
  if(['exploration','refinement'].includes(phase)){
    let status=ev.classification==='FEASIBLE'?'provisionally_feasible':ev.classification==='INFEASIBLE'?'infeasible':'unresolved';
    await run(env.DB,`UPDATE design_candidates SET status=?,evidence_status=?,boundary_score=?,objective_score=?,updated_at=? WHERE id=?`,[status,ev.classification,ev.boundary_score,m.objective_score,nowIso(),candidateId]);
    if(ev.classification==='UNRESOLVED'&&cycle<config.max_refinement)await enqueueComputeOnce(env,projectId,{candidate_id:candidateId,phase:'refinement',cycle:cycle+1},35-Math.min(10,Math.round(ev.boundary_score)));
    else if(ev.classification==='UNRESOLVED') await run(env.DB,`UPDATE design_candidates SET status='boundary_hold',evidence_status='UNRESOLVED',boundary_score=?,updated_at=? WHERE id=?`,[ev.boundary_score,nowIso(),candidateId]);
    if(ev.classification==='FEASIBLE')await enqueueComputeOnce(env,projectId,{candidate_id:candidateId,phase:'confirmation',cycle:0},45);
  } else if(phase==='confirmation'){
    if(ev.classification==='FEASIBLE')await run(env.DB,`UPDATE design_candidates SET status='confirmed_feasible',evidence_status='FEASIBLE',boundary_score=?,objective_score=?,updated_at=? WHERE id=?`,[ev.boundary_score,m.objective_score,nowIso(),candidateId]);
    else if(ev.classification==='INFEASIBLE')await run(env.DB,`UPDATE design_candidates SET status='confirmation_failed',evidence_status='INFEASIBLE',updated_at=? WHERE id=?`,[nowIso(),candidateId]);
    else if(cycle<config.max_confirmation)await enqueueComputeOnce(env,projectId,{candidate_id:candidateId,phase:'confirmation',cycle:cycle+1},42);
    else await run(env.DB,`UPDATE design_candidates SET status='boundary_hold',evidence_status='UNRESOLVED',boundary_score=?,updated_at=? WHERE id=?`,[ev.boundary_score,nowIso(),candidateId]);
  }
  await audit(env,projectId,'agent','cdrs.run','candidate',candidateId,{phase,cycle,classification:ev.classification,boundary_score:ev.boundary_score,metrics:m,seed,result_hash:resultHash,runner_code_revision:env.RUNNER_CODE_REVISION||null,scenario_source:scenarioPack.source,empirical_ready:scenarioPack.empirical_ready,empirical_profile:cal.profile.version});
  return{id,phase,cycle,seed,classification:ev.classification,boundary_score:ev.boundary_score,...m};
}
export async function enqueueRobustValidation(env,projectId){
  const proj=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]); const cycle=Number(proj?.research_cycle||1);
  const cands=await all(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? AND status='confirmed_feasible' AND (NOT EXISTS(SELECT 1 FROM simulation_runs r WHERE r.candidate_id=design_candidates.id AND r.phase='historical') OR NOT EXISTS(SELECT 1 FROM simulation_runs r WHERE r.candidate_id=design_candidates.id AND r.phase='stress')) ORDER BY boundary_score DESC LIMIT 500`,[projectId,cycle]);
  // 후보마다 'SELECT DISTINCT phase' 를 날리던 N+1 루프 → 프로젝트 단위 1회 조회(커버링 인덱스)
  const doneRows=await all(env.DB,`SELECT DISTINCT r.candidate_id,r.phase FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=? AND r.phase IN ('historical','stress')`,[projectId,cycle]);
  const done=new Set(doneRows.map(r=>`${r.candidate_id}|${r.phase}`));
  const hist=[],stress=[];
  for(const c of cands){
    if(!done.has(`${c.id}|historical`))hist.push({candidate_id:c.id,phase:'historical',cycle:0});
    if(!done.has(`${c.id}|stress`))stress.push({candidate_id:c.id,phase:'stress',cycle:0});
  }
  // 작업당 INSERT+큐 전송 1회씩 하던 것을 배치로
  await enqueueMany(env,projectId,'compute_candidate',[...hist,...stress],50);
  return{queued:hist.length+stress.length,candidates:cands.length};
}
export async function computeRegretTable(env,projectId,preloadedRuns=null){
  const proj=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]); const cycle=Number(proj?.research_cycle||1);
  const cands=await all(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? AND status='confirmed_feasible'`,[projectId,cycle]);
  const confirmedIds=new Set(cands.map(c=>c.id));
  // 후보마다 simulation_runs 를 따로 조회하던 N+1 루프 → 프로젝트 단위 1회 조회(호출자가 이미 읽었으면 재사용)
  const runs=preloadedRuns||await all(env.DB,`SELECT candidate_id,phase,result_json FROM simulation_runs WHERE project_id=? AND phase IN ('historical','stress') ORDER BY created_at DESC`,[projectId]);
  const latestBy=new Map(); for(const r of runs){ if(!confirmedIds.has(r.candidate_id)||(r.phase!=='historical'&&r.phase!=='stress'))continue; let m=latestBy.get(r.candidate_id); if(!m){m={};latestBy.set(r.candidate_id,m);} if(!m[r.phase])m[r.phase]=safeJson(r.result_json,{}); }
  const rows=cands.map(c=>({id:c.id,latest:latestBy.get(c.id)||{}}));
  const complete=rows.filter(r=>['historical','stress'].every(ph=>Object.keys(r.latest[ph]?.scenario_scores||{}).length));
  const keys=new Set(complete.flatMap(r=>['historical','stress'].flatMap(ph=>Object.keys(r.latest[ph].scenario_scores).map(k=>ph+':'+k))));
  const eligible=complete.filter(r=>['historical','stress'].reduce((n,ph)=>n+Object.keys(r.latest[ph].scenario_scores).length,0)===keys.size);
  const best={};for(const row of eligible)for(const ph of ['historical','stress'])for(const [key,v] of Object.entries(row.latest[ph].scenario_scores))best[ph+':'+key]=Math.min(best[ph+':'+key]??Infinity,Number(v.objective));
  const enoughCompetition=eligible.length>=2;
  const ids=new Set(enoughCompetition?eligible.map(r=>r.id):[]),result=rows.map(row=>{if(!ids.has(row.id))return {candidate_id:row.id,max_regret:null,mean_regret:null,status:enoughCompetition?'MISSING_SCENARIO_COVERAGE':'INSUFFICIENT_COMPARABLE_CANDIDATES'};const values=['historical','stress'].flatMap(ph=>Object.entries(row.latest[ph].scenario_scores).map(([key,v])=>Math.max(0,Number(v.objective)-best[ph+':'+key])));return {candidate_id:row.id,max_regret:Math.max(...values),mean_regret:mean(values),status:'COMPUTED'};});
  if(result.length){const payload=JSON.stringify(result),ts=nowIso();await env.DB.batch([
   env.DB.prepare(`UPDATE design_candidates SET max_regret=(SELECT json_extract(value,'$.max_regret') FROM json_each(?) WHERE json_extract(value,'$.candidate_id')=design_candidates.id),updated_at=? WHERE id IN (SELECT json_extract(value,'$.candidate_id') FROM json_each(?))`).bind(payload,ts,payload),
   env.DB.prepare(`UPDATE simulation_runs SET regret=(SELECT json_extract(value,'$.max_regret') FROM json_each(?) WHERE json_extract(value,'$.candidate_id')=simulation_runs.candidate_id) WHERE candidate_id IN (SELECT json_extract(value,'$.candidate_id') FROM json_each(?)) AND phase IN ('historical','stress')`).bind(payload,payload)
  ]);}
  return result.sort((a,b)=>(a.max_regret??Infinity)-(b.max_regret??Infinity));
}

// Pure helpers exposed only for deterministic unit tests; production orchestration uses the exported CDRS functions above.
export const __test = { replicationHoldoutScenarios,orthogonalBalancedDesign,designAudit,simulateEpisode,confidenceFor,configFrom,applyNoninferiority,finalizeAgg, emptyAgg, mergeAgg, estimatorStep, empiricalChannel, calibrationUncertaintyScenarios, lossProxyScenarios };
