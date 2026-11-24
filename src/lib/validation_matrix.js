import { all, one } from './db.js';
import { nowIso, uid, safeJson } from './util.js';

const DIMS=['Synthetic','Historical','Adversarial','BIS','ECB','Human'];
const classStatus=v=>v==='FEASIBLE'?'PASS':v==='INFEASIBLE'?'FAIL':v==='UNRESOLVED'?'HOLD':'NA';
const validationStatus=v=>v==='CONFIRM'?'PASS':v==='REJECT'?'FAIL':v==='HOLD'?'HOLD':'NA';

// Bump when the status rules change so cached matrix rows are rebuilt once from stored evidence.
// v2: Human is evaluated for every Synthetic-passing candidate (human_screen) and phase-level
//     non-inferiority contrasts are no longer ignored by the per-group statuses.
export const MATRIX_RULES_VERSION=4;

// Phase-level non-inferiority (candidate vs matched K0 baseline) is stored in result.noninferiority and
// is already part of result.classification, but validation_groups[*].classification is computed before it.
// Without this gate a candidate that fails non-inferiority could still show PASS in a group cell.
function noninferiorityGate(result){
  const cmp=result?.noninferiority?.comparisons;
  if(!Array.isArray(cmp)||!cmp.length)return 'PASS';
  let fail=false,hold=false;
  for(const x of cmp){
    const lo=x?.lo==null?NaN:Number(x.lo),hi=x?.hi==null?NaN:Number(x.hi),lim=x?.limit==null?NaN:Number(x.limit);
    if(!Number.isFinite(lo)||!Number.isFinite(hi)||!Number.isFinite(lim)){hold=true;continue;}
    if(lo>lim)fail=true;else if(hi>lim)hold=true;
  }
  return fail?'FAIL':hold?'HOLD':'PASS';
}
// exact=true  : the group IS the whole phase (Synthetic, Historical) -> FAIL/HOLD apply directly.
// exact=false : the group is a subset of the stress phase; a pooled contrast cannot be attributed to one
//               subset, so it can only stop a PASS (-> HOLD), never create a FAIL.
export function withNoninferiority(status,result,{exact=false}={}){
  if(status!=='PASS'&&status!=='HOLD'&&status!=='FAIL')return status;
  const ni=noninferiorityGate(result);
  if(ni==='PASS')return status;
  if(exact){
    if(ni==='FAIL'||status==='FAIL')return 'FAIL';
    return 'HOLD';
  }
  return status==='PASS'?'HOLD':status;
}

// Match thesis.js scenario-level evidence fallback. Missing metrics/constraints are
// HOLD (insufficient evidence), never an invented PASS.
function scenarioGate(result,group,predicate,constraints){
  const explicit=result?.validation_groups?.[group]?.classification;
  if(explicit)return withNoninferiority(classStatus(explicit),result,{exact:false});
  const scenarios=Object.entries(result?.scenario_scores||{}).filter(([key])=>predicate(key));
  if(!scenarios.length)return 'NA';
  const codes=scenarios.map(([,score])=>{
    if(score?.classification)return classStatus(score.classification);
    // Legacy point estimates alone cannot establish a confidence-bound failure or pass.
    return 'HOLD';
  });
  if(codes.includes('FAIL'))return 'FAIL';
  if(codes.includes('HOLD')||codes.includes('NA'))return 'HOLD';
  return withNoninferiority(codes.every(c=>c==='PASS')?'PASS':'HOLD',result,{exact:false});
}

function overall(row){
  const xs=DIMS.map(k=>row[k.toLowerCase()+'_status']).filter(x=>x&&x!=='NA');
  if(xs.includes('FAIL'))return 'FAIL';
  if(xs.includes('HOLD'))return 'HOLD';
  if(xs.length===DIMS.length&&xs.every(x=>x==='PASS'))return 'PASS';
  if(xs.length)return 'PARTIAL';
  return 'NA';
}
function latestByCandidate(rows){const m=new Map();for(const r of rows)if(!m.has(`${r.candidate_id}|${r.phase}`))m.set(`${r.candidate_id}|${r.phase}`,r);return m;}
export async function refreshValidationMatrix(env,projectId,{candidateId=null}={}){
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);
  if(!p)throw new Error('project_not_found');
  const cycle=Number(p.research_cycle||1),rev=Number(p.evidence_revision||0);
  const cands=candidateId
    ?await all(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? AND id=?`,[projectId,cycle,candidateId])
    :await all(env.DB,`SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? ORDER BY id`,[projectId,cycle]);
  const config=await one(env.DB,`SELECT constraints_json FROM project_config WHERE project_id=?`,[projectId]);
  const constraints=safeJson(config?.constraints_json,{});
  if(!cands.length)return {rows:0,cycle,revision:rev};
  const runs=await all(env.DB,`SELECT r.candidate_id,r.phase,r.result_json FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=? AND r.evidence_revision=? AND r.phase IN ('confirmation','historical','stress') AND (? IS NULL OR r.candidate_id=?) ORDER BY r.created_at DESC`,[projectId,cycle,rev,candidateId,candidateId]);
  const targetIds=candidateId?new Set([candidateId]):null;
  const runMap=latestByCandidate(targetIds?runs.filter(r=>targetIds.has(r.candidate_id)):runs);
  // Human gate: 'human_recompute' (robust-confirmed candidates, drives approval) wins over 'human_screen'
  // (same current-revision reviewer-model recompute for every other Synthetic-passing candidate, display only).
  const humans=await all(env.DB,`SELECT candidate_id,validation_type,status,result_json FROM validations WHERE project_id=? AND evidence_revision=? AND validation_type IN ('human_recompute','human_screen') AND (? IS NULL OR candidate_id=?) ORDER BY created_at DESC`,[projectId,rev,candidateId,candidateId]);
  const humanMap=new Map();
  for(const h of humans){
    if(targetIds&&!targetIds.has(h.candidate_id))continue;
    const cur=humanMap.get(h.candidate_id);
    if(!cur||(cur.validation_type==='human_screen'&&h.validation_type==='human_recompute'))humanMap.set(h.candidate_id,h);
  }
  // Read lazily: only needed to explain why a Synthetic-passing candidate has no Human verdict yet.
  let reviewerModelReady=null;
  const hasReviewerModel=async()=>{
    if(reviewerModelReady===null)reviewerModelReady=!!(await one(env.DB,`SELECT 1 x FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? LIMIT 1`,[projectId,cycle,rev]));
    return reviewerModelReady;
  };
  const fit=await one(env.DB,`SELECT action,detail_json FROM audit_log WHERE project_id=? AND action IN ('reviewer.fit.fail','reviewer.fit.hold','reviewer.fit.complete') ORDER BY created_at DESC,id DESC LIMIT 1`,[projectId]);
  const fitDetail=safeJson(fit?.detail_json,{});
  const humanFailed=fit?.action==='reviewer.fit.fail'&&fitDetail.cycle===cycle&&fitDetail.revision===rev;
  const ts=nowIso(),stmts=[];let pass=0,fail=0,hold=0,partial=0;
  for(const c of cands){
    const conf=safeJson(runMap.get(`${c.id}|confirmation`)?.result_json,{}),hist=safeJson(runMap.get(`${c.id}|historical`)?.result_json,{}),stress=safeJson(runMap.get(`${c.id}|stress`)?.result_json,{}),h=humanMap.get(c.id);
    const groups=stress.validation_groups||{};
    const row={
      synthetic_status:withNoninferiority(classStatus(conf.validation_groups?.Synthetic?.classification||conf.classification),conf,{exact:true}),
      historical_status:withNoninferiority(classStatus(hist.validation_groups?.Historical?.classification||hist.classification),hist,{exact:true}),
      adversarial_status:scenarioGate(stress,'Adversarial',k=>!/^official_(bis|ecb)_/i.test(k),constraints),
      bis_status:scenarioGate(stress,'BIS',k=>/^official_bis_/i.test(k),constraints),
      ecb_status:scenarioGate(stress,'ECB',k=>/^official_ecb_/i.test(k),constraints),
      human_status:'NA'
    };
    // Human: real verdict when a recompute/screen row exists. A Synthetic-passing candidate without one is
    // HOLD (insufficient human evidence), never NA and never an invented PASS. Candidates that did not pass
    // Synthetic confirmation are never sent to the human gate, so they stay NA.
    let humanDetail=null;
    if(humanFailed&&row.synthetic_status==='PASS'){row.human_status='FAIL';humanDetail={status:'FAIL',source:'reviewer_fit',reason:fitDetail.reason,result:fitDetail};}
    else if(h){row.human_status=validationStatus(h.status);humanDetail={status:h.status,source:h.validation_type,result:safeJson(h.result_json,{})};}
    else if(row.synthetic_status==='PASS'){
      row.human_status='HOLD';
      humanDetail={status:'HOLD',source:'pending',reason:(await hasReviewerModel())?'HUMAN_RECOMPUTE_PENDING':'HUMAN_REVIEWER_MODEL_PENDING',result:{}};
    }
    row.overall_status=overall(row);
    if(row.overall_status==='PASS')pass++;else if(row.overall_status==='FAIL')fail++;else if(row.overall_status==='HOLD')hold++;else partial++;
    const detail={failed_dimensions:DIMS.filter(k=>row[k.toLowerCase()+'_status']==='FAIL'),pending_dimensions:DIMS.filter(k=>['HOLD','NA'].includes(row[k.toLowerCase()+'_status'])),synthetic:conf.validation_groups?.Synthetic||null,historical:hist.validation_groups?.Historical||null,adversarial:groups.Adversarial||null,bis:groups.BIS||null,ecb:groups.ECB||null,human:humanDetail,rules_version:MATRIX_RULES_VERSION};
    stmts.push(env.DB.prepare(`INSERT INTO candidate_validation_matrix(id,project_id,candidate_id,research_cycle,evidence_revision,synthetic_status,historical_status,adversarial_status,bis_status,ecb_status,human_status,overall_status,detail_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,candidate_id,research_cycle,evidence_revision) DO UPDATE SET synthetic_status=excluded.synthetic_status,historical_status=excluded.historical_status,adversarial_status=excluded.adversarial_status,bis_status=excluded.bis_status,ecb_status=excluded.ecb_status,human_status=excluded.human_status,overall_status=excluded.overall_status,detail_json=excluded.detail_json,updated_at=excluded.updated_at`).bind(uid('vmat'),projectId,c.id,cycle,rev,row.synthetic_status,row.historical_status,row.adversarial_status,row.bis_status,row.ecb_status,row.human_status,row.overall_status,JSON.stringify(detail),ts));
  }
  for(let i=0;i<stmts.length;i+=50)await env.DB.batch(stmts.slice(i,i+50));
  return {rows:cands.length,pass,fail,hold,partial,cycle,revision:rev};
}
async function matrixRows(env,projectId,cycle,rev){
  return all(env.DB,`SELECT m.*,c.estimator,c.sigma,c.alpha,c.authority_k,c.delay_d,c.max_regret,c.status candidate_status FROM candidate_validation_matrix m JOIN design_candidates c ON c.id=m.candidate_id WHERE m.project_id=? AND m.research_cycle=? AND m.evidence_revision=? ORDER BY CASE m.overall_status WHEN 'PASS' THEN 1 WHEN 'PARTIAL' THEN 2 WHEN 'HOLD' THEN 3 WHEN 'FAIL' THEN 4 ELSE 5 END, COALESCE(c.max_regret,999999),c.authority_k DESC,c.sigma`,[projectId,cycle,rev]);
}
export async function getValidationMatrix(env,projectId){
  const p=await one(env.DB,`SELECT name,research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const currentCycle=Number(p.research_cycle||1),currentRev=Number(p.evidence_revision||0);
  let cycle=currentCycle,rev=currentRev,rows=await matrixRows(env,projectId,cycle,rev),stale=false,snapshotUpdatedAt=null;
  // Matrix is a derived D1 cache, not the source of truth. A migration (0024),
  // interrupted G3, or new run arriving before G3 can leave it empty/stale.
  // Reconcile on GET only when authoritative candidate/run/human evidence changed.
  const source=await one(env.DB,`SELECT
    (SELECT COUNT(*) FROM design_candidates WHERE project_id=? AND research_cycle=?) candidates,
    (SELECT MAX(r.created_at) FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id
      WHERE r.project_id=? AND c.research_cycle=? AND r.evidence_revision=? AND r.phase IN ('confirmation','historical','stress')) latest_run,
    (SELECT MAX(v.created_at) FROM validations v JOIN design_candidates c ON c.id=v.candidate_id
      WHERE v.project_id=? AND c.research_cycle=? AND v.evidence_revision=? AND v.validation_type IN ('human_recompute','human_screen')) latest_human`,
    [projectId,currentCycle,projectId,currentCycle,currentRev,projectId,currentCycle,currentRev]);
  const cachedTime=rows.reduce((m,r)=>m===null||String(r.updated_at||'')<m?String(r.updated_at||''):m,null)||'';
  const newEvidence=[source?.latest_run,source?.latest_human].some(t=>String(t||'')>cachedTime);
  // Deployment upgrades may add scenario-level interpretation without changing
  // run timestamps. Rebuild a legacy NA-only cache once from stored stress evidence.
  let legacyScenarioCache=false;
  if(rows.some(r=>r.adversarial_status==='NA'||r.bis_status==='NA'||r.ecb_status==='NA')){
    const stressRows=await all(env.DB,`SELECT r.candidate_id,r.result_json FROM simulation_runs r
      JOIN design_candidates c ON c.id=r.candidate_id
      WHERE r.project_id=? AND c.research_cycle=? AND r.evidence_revision=? AND r.phase='stress'
      ORDER BY r.created_at DESC`,[projectId,currentCycle,currentRev]);
    const latest=new Map();for(const r of stressRows)if(!latest.has(r.candidate_id))latest.set(r.candidate_id,safeJson(r.result_json,{}));
    legacyScenarioCache=rows.some(row=>{
      const result=latest.get(row.candidate_id);if(!result)return false;
      return [['adversarial',k=>!/^official_(bis|ecb)_/i.test(k)],['bis',k=>/^official_bis_/i.test(k)],['ecb',k=>/^official_ecb_/i.test(k)]].some(([gate,pred])=>
        row[gate+'_status']==='NA' && Object.keys(result.scenario_scores||{}).some(pred));
    });
  }

  // Rows cached by an older rule set (e.g. Human always N/A for non-robust candidates) are rebuilt once
  // from stored evidence; refreshed rows carry rules_version so this cannot loop.
  const legacyRules=rows.some(r=>Number(safeJson(r.detail_json,{}).rules_version||0)!==MATRIX_RULES_VERSION);
  if(Number(source?.candidates||0)>0 && (rows.length!==Number(source.candidates)||newEvidence||legacyScenarioCache||legacyRules)){
    await refreshValidationMatrix(env,projectId);
    rows=await matrixRows(env,projectId,currentCycle,currentRev);
  }
  // A new revision can contain placeholder NA rows. Treat them as not yet validated,
  // retaining the last informative snapshot instead of rendering a wiped figure.
  const noObservedGates = rs => !rs.some(r=>DIMS.some(k=>['PASS','FAIL','HOLD'].includes(r[k.toLowerCase()+'_status'])));
  if(!rows.length || noObservedGates(rows)){
    const snap=await one(env.DB,`SELECT research_cycle,evidence_revision,MAX(updated_at) updated_at FROM candidate_validation_matrix WHERE project_id=? AND (research_cycle<? OR (research_cycle=? AND evidence_revision<?)) GROUP BY research_cycle,evidence_revision ORDER BY research_cycle DESC,evidence_revision DESC LIMIT 1`,[projectId,currentCycle,currentCycle,currentRev]);
    if(snap){ cycle=Number(snap.research_cycle||1);rev=Number(snap.evidence_revision||0);snapshotUpdatedAt=snap.updated_at||null;rows=await matrixRows(env,projectId,cycle,rev);stale=rows.length>0; }
  }
  if(!snapshotUpdatedAt&&rows.length)snapshotUpdatedAt=rows.reduce((m,r)=>String(r.updated_at||'')>String(m||'')?r.updated_at:m,null);
  const summary={total:rows.length,PASS:0,PARTIAL:0,HOLD:0,FAIL:0,NA:0,dimensions:{}};
  for(const k of DIMS)summary.dimensions[k]={PASS:0,HOLD:0,FAIL:0,NA:0};
  for(const r of rows){summary[r.overall_status]=(summary[r.overall_status]||0)+1;for(const k of DIMS){const s=r[k.toLowerCase()+'_status']||'NA';summary.dimensions[k][s]=(summary.dimensions[k][s]||0)+1;}}
  return {project_id:projectId,project_name:p.name||projectId,cycle,revision:rev,current_cycle:currentCycle,current_revision:currentRev,stale,stale_reason:stale?'CURRENT_REVISION_REVALIDATION_PENDING':null,snapshot_updated_at:snapshotUpdatedAt,served_at:nowIso(),generated_at:snapshotUpdatedAt||nowIso(),basis:stale?'LAST_KNOWN_VALID_SNAPSHOT':'CURRENT_PROJECT_ONLY',dimensions:DIMS,summary,rows:rows.map(r=>({...r,detail:safeJson(r.detail_json,{})}))};
}
