import {currentFinal} from './research_final.js';
import {gridEffects,boundaryPlan} from './research_effects.js';
import {matchedSigma,propositions,stoppingStatus,stoppingRecommendation} from './research_followup.js';
import {all,one,run} from './db.js';
import {safeJson,nowIso,uid,sha256Hex,stableStringify} from './util.js';
import {getValidationMatrix} from './validation_matrix.js';
import {latestProtocol} from './rigor.js';
import {replicationStatus} from './replication.js';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export const limits={fn_rate:'fn_max',fp_rate:'fp_max',review_burden:'review_burden_max',loss_mean:'loss_max',loss_exceed_rate:'loss_exceed_max',recovery_time:'recovery_time_max'};
export function sensitivity(rows,base){
 const keys=['fn_max','fp_max','review_burden_max','loss_exceed_max','recovery_time_max'];
 const grids=Object.fromEntries(keys.filter(k=>finite(base[k])&&base[k]>=0).map(k=>[k,[.5,.75,1,1.25,1.5].map(f=>Math.min(k==='recovery_time_max'?Infinity:1,base[k]*f))]));
 const evaluate=c=>{let PASS=0,FAIL=0,HOLD=0;for(const r of rows){const tests=Object.entries(limits).map(([m,k])=>{const q=r.ci?.[m],lim=c[k];return !finite(q?.lo)||!finite(q?.hi)||q.lo>q.hi||!finite(lim)?'HOLD':q.lo>lim?'FAIL':q.hi<=lim?'PASS':'HOLD';});if(tests.includes('FAIL'))FAIL++;else if(tests.every(x=>x==='PASS'))PASS++;else HOLD++;}return {PASS,FAIL,HOLD};};
 return {scope:'confirmation CI; exploratory absolute constraints only; loss event threshold fixed; excludes noninferiority and external gates',n:rows.length,baseline:evaluate(base),curves:Object.fromEntries(Object.entries(grids).map(([k,g])=>[k,g.map(v=>({threshold:v,...evaluate({...base,[k]:v})}))])),joint:(grids.fn_max||[]).flatMap(fn=>(grids.review_burden_max||[]).map(review=>({fn,review,...evaluate({...base,fn_max:fn,review_burden_max:review})})))};
}
export function hypothesis({lo,hi,minimum=0,direction=1,eligible=false}){if(!eligible||![lo,hi,minimum].every(finite)||lo>hi||minimum<0||![1,-1].includes(direction))return 'INCONCLUSIVE';const lower=direction===1?lo:-hi,upper=direction===1?hi:-lo;return lower>minimum?'SUPPORTED':upper<minimum?'REFUTED':'INCONCLUSIVE';}
export function decision({system,unresolved,replicated,budgetReached=false,alternative=false,irreparable=false}){if(system!=='PASS')return 'CONTINUE';if(!unresolved&&replicated)return 'COMPLETE';if(budgetReached)return alternative?'PIVOT':irreparable?'DROP':'PIVOT';return 'CONTINUE';}
export async function researchDashboard(env,id){
 const p=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[id]);if(!p)throw Error('project_not_found');const cycle=Number(p.research_cycle),revision=Number(p.evidence_revision);
 const [matrix,cfg,protocol,replication,rows,checks]=await Promise.all([getValidationMatrix(env,id),one(env.DB,'SELECT constraints_json,benchmark_json FROM project_config WHERE project_id=?',[id]),latestProtocol(env,id),replicationStatus(env,id),all(env.DB,`SELECT r.candidate_id,r.result_json,c.sigma,c.tau,c.alpha,c.authority_k,c.delay_d,c.recovery_w,c.adjust_m,c.estimator FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=? AND r.evidence_revision=? AND r.phase='confirmation' ORDER BY r.created_at DESC,r.id DESC`,[id,cycle,revision]),all(env.DB,"SELECT status,result_json FROM rigor_checks WHERE project_id=? AND check_type='research_system_attestation' ORDER BY created_at DESC LIMIT 20",[id])]);
 const seen=new Set(),used=[],contrasts=[];for(const r of rows){if(seen.has(r.candidate_id))continue;seen.add(r.candidate_id);const j=safeJson(r.result_json,{});used.push(j);const v=j.classification;contrasts.push({...r,boundary_score:j.boundary_score,verdict:v==='FEASIBLE'?'PASS':v==='INFEASIBLE'?'FAIL':'HOLD'});}
 const current=!matrix.stale&&matrix.cycle===cycle&&matrix.revision===revision;const att=checks.find(x=>{const a=safeJson(x.result_json,{});return a.cycle===cycle&&a.revision===revision&&a.code_revision===env.RUNNER_CODE_REVISION&&!!env.RUNNER_CODE_REVISION;});
 const sourceTests=att?.status==='PASS'?'PASS':att?.status==='FAIL'?'FAIL':'UNVERIFIED'; const orphan=await one(env.DB,`SELECT COUNT(*) n FROM validations v WHERE v.project_id=? AND v.evidence_revision=? AND v.candidate_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM design_candidates c WHERE c.id=v.candidate_id AND c.project_id=v.project_id AND c.research_cycle=?)`,[id,revision,cycle]);
 const protocolHashValid=protocol?.protocol_hash?await sha256Hex(stableStringify(protocol.protocol))===protocol.protocol_hash:null;
 const liveChecks={current_matrix:current&&matrix.rows.length>0,orphan_current_validations:Number(orphan?.n||0),protocol_hash_valid:protocolHashValid};
 const system=systemVerdict(sourceTests,liveChecks);
 const effects=gridEffects(contrasts);
 const stop=await stoppingStatus(env,id,cycle);const confirm=await currentFinal(env,id);
 const verdicts=confirm?.result?.region_propositions;
 const statuses=Object.entries(propositions).map(([id,label])=>({id,label,status:system==='FAIL'?'INCONCLUSIVE':verdicts?.[id]||'INCONCLUSIVE',scope:'registered computational grid only',...(id==='P1'?{exploratory:matchedSigma(contrasts)}:{})}));
 const recommendation=system==='FAIL'?'CONTINUE_REPAIR':system!=='PASS'?'CONTINUE_VERIFY':verdicts&&statuses.every(h=>h.status!=='INCONCLUSIVE')?'COMPLETE_COMPUTATION_REVIEW':stop?.budget_reached?'PIVOT_REVIEW':'CONTINUE';
 const latest=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[id]);if(Number(latest.research_cycle)!==cycle||Number(latest.evidence_revision)!==revision)throw Error('evidence_changed_retry');
 return {cycle,revision,confirmatory_computation:confirm,system,live_checks:liveChecks,source_tests:sourceTests,candidates:current?matrix.summary:null,candidate_basis:current?'CURRENT':'STALE',boundary_plan:boundaryPlan(contrasts),grid_effects:effects,hypotheses:statuses,sensitivity:sensitivity(used,safeJson(cfg?.constraints_json,{})),loss_policy:safeJson(cfg?.benchmark_json,{}).loss_policy||{mode:'baseline'},protocol_hash:protocol?.protocol_hash||null,replication_status:replication.status,stopping:stop,recommendation,recommendation_basis:'Advisory only; computational completion is not scientific completion; live system integrity and independent empirical evidence remain separate'};
}

export function systemVerdict(source,checks){return source==='FAIL'||checks.orphan_current_validations>0||checks.protocol_hash_valid===false?'FAIL':source==='PASS'&&checks.current_matrix&&checks.orphan_current_validations===0&&checks.protocol_hash_valid===true?'PASS':'UNVERIFIED';}
