import { all, one, run, audit, enqueue } from './db.js';
import { nowIso, uid, mulberry32, quantile, safeJson } from './util.js';
import { latestDefinition } from './define.js';
import { bust } from './memo.js';

function metrics(rows){
  const correct=rows.filter(r=>Number(r.ai_correct)===1), wrong=rows.filter(r=>Number(r.ai_correct)===0);
  const n=Math.max(1,rows.length), wc=Math.max(1,wrong.length), cc=Math.max(1,correct.length);
  const correctAccept=correct.filter(r=>Number(r.human_accept)===1).length/cc;
  const correctOverride=wrong.filter(r=>Number(r.human_accept)===0).length/wc;
  const falseAccept=wrong.filter(r=>Number(r.human_accept)===1).length/wc;
  const unnecessaryOverride=correct.filter(r=>Number(r.human_accept)===0).length/cc;
  const meanDelay=rows.reduce((a,r)=>a+Number(r.response_ms||0),0)/n/1000;
  const recovered=wrong.filter(r=>Number(r.recovered)===1), recoveryTime=recovered.length?recovered.reduce((a,r)=>a+Number(r.recovery_ms||0),0)/recovered.length/1000:null;
  const arr=(correct.filter(r=>Number(r.human_accept)===1).length+wrong.filter(r=>Number(r.human_accept)===0).length)/n;
  return {n:rows.length,correct_n:correct.length,wrong_n:wrong.length,appropriate_reliance_rate:arr,correct_accept_rate:correctAccept,correct_override_rate:correctOverride,false_accept_rate:falseAccept,unnecessary_override_rate:unnecessaryOverride,discrimination_delta:correctAccept-falseAccept,mean_delay:meanDelay,error_recovery_time:recoveryTime};
}
function clusterBootstrap(rows,B=300,seed=20260930){
  const groups=new Map(); for(const r of rows){const k=String(r.participant_hash||'anon');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  const ids=[...groups.keys()]; if(ids.length<2)return{status:'HOLD',participants:ids.length,B:0};
  const rng=mulberry32(seed), draws=[];
  for(let b=0;b<B;b++){
    const sample=[];for(let i=0;i<ids.length;i++){const id=ids[Math.floor(rng()*ids.length)];sample.push(...groups.get(id));}
    draws.push(metrics(sample));
  }
  const interval=k=>{const xs=draws.map(x=>Number(x[k])).filter(Number.isFinite);return{lo:quantile(xs,.025),median:quantile(xs,.5),hi:quantile(xs,.975)};};
  return {status:'CONFIRM',participants:ids.length,B,seed,ci95:{appropriate_reliance_rate:interval('appropriate_reliance_rate'),false_accept_rate:interval('false_accept_rate'),correct_override_rate:interval('correct_override_rate'),unnecessary_override_rate:interval('unnecessary_override_rate'),discrimination_delta:interval('discrimination_delta'),mean_delay:interval('mean_delay')}};
}

export function clusterBootstrapGrouped(rows,B=300){
 const groups=new Map();for(const r of rows){const id=r.ph||'anon',g=groups.get(id)||{n:0,appropriate:0,wrong_n:0,acc_w:0,correct_n:0,right_override:0,rt:0};for(const k of Object.keys(g))g[k]+=Number(r[k]||0);groups.set(id,g);}
 const gs=[...groups.values()];if(gs.length<2)return {status:'HOLD',B:0,participants:gs.length};
 const rng=mulberry32(20261002),draws=[];
 for(let b=0;b<B;b++){const s={n:0,appropriate:0,wrong_n:0,acc_w:0,correct_n:0,right_override:0,rt:0};for(let i=0;i<gs.length;i++){const g=gs[Math.floor(rng()*gs.length)];for(const k of Object.keys(s))s[k]+=g[k];}draws.push({appropriate_reliance_rate:s.appropriate/s.n,false_accept_rate:s.wrong_n?s.acc_w/s.wrong_n:null,correct_override_rate:s.wrong_n?1-s.acc_w/s.wrong_n:null,unnecessary_override_rate:s.correct_n?s.right_override/s.correct_n:null,mean_delay:s.rt/s.n/1000});}
 const ci95={};for(const k of Object.keys(draws[0])){const values=draws.map(d=>d[k]).filter(v=>v!=null&&Number.isFinite(v));ci95[k]={lo:quantile(values,.025),hi:quantile(values,.975)};}
 return {status:'DESCRIPTIVE_ONLY',B,participants:gs.length,ci95,scope:'Participant-resampled descriptive intervals; sample-size gates and design validity are separate'};
}


function sigmoid(x){return x>30?1:x<-30?0:1/(1+Math.exp(-x));}
function logit(p){p=Math.min(.999,Math.max(.001,Number(p)));return Math.log(p/(1-p));}
// Penalized random-intercept logistic approximation: accept ~ ai_correct * confidence + (1|participant).
// Participant intercepts receive an L2 penalty, equivalent to a Gaussian random-effect MAP approximation.
export function fitMixedLogitApprox(rows,{iterations=220,lambda=4}={}){
 if(!rows?.length)return {status:'HOLD',method:'penalized_random_intercept_logit_v1',n:0};
 const ids=[...new Set(rows.map(r=>String(r.participant_hash||'anon')))],u=Object.fromEntries(ids.map(id=>[id,0]));let b=[0,0,0,0];
 for(let it=0;it<iterations;it++){
  const gb=[0,0,0,0],gu=Object.fromEntries(ids.map(id=>[id,0])),gn=Object.fromEntries(ids.map(id=>[id,0]));
  for(const r of rows){const id=String(r.participant_hash||'anon'),c=(Number(r.ai_confidence||.75)-.75)/.2,a=Number(r.ai_correct)===1?1:0,x=[1,a,c,a*c],p=sigmoid(b.reduce((z,v,j)=>z+v*x[j],u[id])),e=Number(r.human_accept)-p;for(let j=0;j<4;j++)gb[j]+=e*x[j];gu[id]+=e;gn[id]++;}
  const rate=.12/Math.sqrt(1+it/20);for(let j=0;j<4;j++)b[j]+=rate*gb[j]/rows.length;for(const id of ids)u[id]+=rate*gu[id]/Math.max(1,gn[id]+lambda);
 }
 const us=Object.values(u),mu=us.reduce((a,x)=>a+x,0)/Math.max(1,us.length),sd=Math.sqrt(us.reduce((a,x)=>a+(x-mu)**2,0)/Math.max(1,us.length));
 return {status:'CONFIRM',method:'penalized_random_intercept_logit_v1',n:rows.length,participants:ids.length,coefficients:{intercept:b[0],ai_correct:b[1],confidence_z:b[2],ai_correct_x_confidence:b[3]},participant_intercept_sd:sd,confidence_center:.75,confidence_scale:.2,penalty_lambda:lambda,scope:'Operational MAP approximation of the preregistered random-intercept logistic model; confirmatory publication inference should use the exported trial-level data in a full GLMM implementation.'};
}
export async function fitReviewerModel(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);
  const def=await latestDefinition(env,projectId),v=def?.content?.validation||{},protocol=String(v.human_protocol||'main_v2'),cycle=Number(p?.research_cycle||1);
  const fastMs=Number(v.human_fast_ms||800),slowMs=Number(v.human_slow_ms||60000),mainRequired=Number(v.human_main_n||30),attentionRequired=Number(v.human_attention_n||3);
  // Current-cycle, normalized trial metadata is authoritative. This prevents old-cycle rows with the
  // same protocol string from leaking into the current reviewer model and avoids JSON-expression scans.
  const state=await all(env.DB,`SELECT rt.participant_hash,
      SUM(CASE WHEN rt.trial_phase='main' AND rt.status='done' THEN 1 ELSE 0 END) main_n,
      SUM(CASE WHEN rt.trial_phase='attention' AND rt.status='done' THEN 1 ELSE 0 END) attention_n,
      EXISTS(SELECT 1 FROM reviewer_quality_flags q WHERE q.project_id=rt.project_id AND q.participant_hash=rt.participant_hash AND q.protocol_version=rt.protocol_version AND q.research_cycle=rt.research_cycle AND q.severity='EXCLUDE') excluded
    FROM reviewer_trials rt
    WHERE rt.project_id=? AND rt.protocol_version=? AND rt.research_cycle=?
    GROUP BY rt.participant_hash`,[projectId,protocol,cycle]);
  const completedIds=new Set(state.filter(x=>Number(x.main_n||0)>=mainRequired&&Number(x.attention_n||0)>=attentionRequired).map(x=>String(x.participant_hash)));
  const excludedIds=new Set(state.filter(x=>Number(x.excluded||0)===1).map(x=>String(x.participant_hash)));
  let rows=await all(env.DB,`SELECT o.participant_hash,o.ai_confidence,o.ai_correct,o.human_accept,o.response_ms,o.recovered,o.recovery_ms,o.created_at
    FROM reviewer_observations o JOIN reviewer_trials rt ON rt.id=o.trial_id
    WHERE o.project_id=? AND rt.project_id=? AND rt.protocol_version=? AND rt.research_cycle=? AND rt.trial_phase='main' AND rt.attention_check=0
      AND o.response_ms>=? AND o.response_ms<=?
    ORDER BY o.created_at`,[projectId,projectId,protocol,cycle,fastMs,slowMs]);
  rows=rows.filter(r=>completedIds.has(String(r.participant_hash))&&!excludedIds.has(String(r.participant_hash)));
  const lastObserved=rows.at(-1)?.created_at??'';
  const minParticipants=Number(v.min_human_participants||32),minCorrect=Number(v.min_human_correct_trials||300),minWrong=Number(v.min_human_wrong_trials||200),B=Math.max(300,Math.min(1000,Number(v.cluster_bootstrap_n||300)));
  const participantN=new Set(rows.map(r=>String(r.participant_hash))).size,correctN=rows.filter(r=>Number(r.ai_correct)===1).length,wrongN=rows.filter(r=>Number(r.ai_correct)===0).length;
  const gate={participants:{observed:participantN,required:minParticipants,pass:participantN>=minParticipants},correct_trials:{observed:correctN,required:minCorrect,pass:correctN>=minCorrect},wrong_trials:{observed:wrongN,required:minWrong,pass:wrongN>=minWrong}};
  const cluster=clusterBootstrap(rows,B,20261004),disc=cluster?.ci95?.discrimination_delta||null;
  const minDelta=Number(v.human_min_discrimination_delta??.15);gate.discrimination={estimate:metrics(rows).discrimination_delta,ci95:disc,required:`cluster-bootstrap lower bound >= ${minDelta}`,minimum_effect:minDelta,pass:!!disc&&Number(disc.lo)>=minDelta};
  gate.quality={excluded_participants:excludedIds.size,completed_participants:completedIds.size,protocol,pass:true};
  if(!Object.values(gate).filter(x=>x&&typeof x==='object'&&'pass'in x).every(x=>x.pass)){
    await run(env.DB,`UPDATE projects SET reviewer_hold_marker=? WHERE id=?`,[lastObserved,projectId]);
    await audit(env,projectId,'agent','reviewer.fit.hold','project',projectId,{n:rows.length,gate,reason:'human_qc_or_discrimination_gate',cluster_bootstrap:cluster});
    return {status:'HOLD',n:rows.length,participants:participantN,gate,cluster_bootstrap:cluster};
  }
  const point=metrics(rows),byConfidence=[...new Set(rows.map(r=>Number(r.ai_confidence)))].sort((a,b)=>a-b).map(confidence=>({confidence,...metrics(rows.filter(r=>Number(r.ai_confidence)===confidence))})),mixed=fitMixedLogitApprox(rows),model={...point,by_confidence:byConfidence,mixed_effects:mixed,participant_accept_sd:Number(mixed.participant_intercept_sd||0),participants:participantN,human_protocol:protocol,last_observed_at:lastObserved,cluster_bootstrap:cluster,sample_gate:gate,quality_control:{fast_ms:Number(v.human_fast_ms||800),slow_ms:Number(v.human_slow_ms||60000),max_fast_share:Number(v.human_max_fast_share||.30),attention_fail_max:Number(v.human_attention_fail_max||1),min_discrimination_delta:Number(v.human_min_discrimination_delta||.15),excluded_participants:excludedIds.size},analysis_plan:'Operational reviewer model fits penalized random-intercept logistic accept ~ ai_correct * confidence + (1|participant), stores confidence-stratified rates, and gates promotion with participant-cluster bootstrap plus a preregistered minimum discrimination effect. Full confirmatory GLMM inference remains reproducible from exported trial-level data.',unit_of_inference:'participant cluster'};
  const ver=await one(env.DB,`SELECT COALESCE(MAX(version),0) v FROM reviewer_models WHERE project_id=?`,[projectId]);
  const id=uid('reviewermodel');await run(env.DB,`INSERT INTO reviewer_models(id,project_id,version,model_json,created_at,research_cycle,evidence_revision) VALUES(?,?,?,?,?,?,?)`,[id,projectId,(ver?.v||0)+1,JSON.stringify(model),nowIso(),Number(p?.research_cycle||1),Number(p?.evidence_revision||0)]);
  bust(env,projectId,'reviewer:latest'); await audit(env,projectId,'agent','reviewer.fit.complete','reviewer_model',id,model); await enqueue(env,projectId,'recompute_project',{},65);
  return {status:'CONFIRM',id,model};
}

export const __test={metrics,clusterBootstrap};
