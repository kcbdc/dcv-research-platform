import { one, run, audit, enqueueOnce } from './db.js';
import { nowIso, uid } from './util.js';
import { bust } from './memo.js';

const STAGES=['define','measure','compute','validate','recompute','approved','report'];
export function impactForEvidence(kind){
  const k=String(kind||'').toUpperCase();
  if(k==='HUMAN_TRIAL'||k==='HUMAN_REVIEW'||k==='REVERIFICATION_REVIEW') return 'validate';
  if(k==='RAW_OBSERVATION'||k==='EXTERNAL_DATA'||k==='EMPIRICAL_EPISODE') return 'measure';
  if(k==='SCENARIO'||k==='BENCHMARK_UPDATE') return 'compute';
  if(k==='DESIGN_CHANGE'||k==='CONSTRAINT_CHANGE'||k==='RQ_CHANGE') return 'define';
  return 'validate';
}
function earlierStage(a,b){
  const ia=STAGES.indexOf(a),ib=STAGES.indexOf(b); if(ia<0)return b;if(ib<0)return a;return ia<=ib?a:b;
}
async function snapshot(env,p,reason,nextRevision,nextCycle){
  // Snapshot is audit metadata, not an analytical aggregate. Reuse materialized cycle counters
  // instead of rescanning the two largest tables whenever evidence changes.
  const counts=await one(env.DB,`SELECT
    COALESCE(s.candidate_total,p.candidate_count,0) candidates,
    COALESCE(s.simulation_total,0) runs,
    (SELECT COUNT(*) FROM validations v WHERE v.project_id=p.id AND (v.evidence_revision IS NULL OR v.evidence_revision<=p.evidence_revision)) validations,
    (SELECT COUNT(*) FROM approvals a WHERE a.project_id=p.id) approvals,
    (SELECT COUNT(*) FROM reports r WHERE r.project_id=p.id) reports
    FROM projects p LEFT JOIN project_cycle_stats s ON s.project_id=p.id AND s.research_cycle=p.research_cycle
    WHERE p.id=?`,[p.id]);
  const snap={project_status:p.status,current_stage:p.current_stage,research_cycle:Number(p.research_cycle||1),evidence_revision:Number(p.evidence_revision||0),counts};
  await run(env.DB,`INSERT INTO evidence_snapshots(id,project_id,research_cycle,evidence_revision,reason,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)`,[uid('snapshot'),p.id,Number(p.research_cycle||1),nextRevision,reason,JSON.stringify(snap),nowIso()]);
}
export async function registerEvidence(env,projectId,{kind,impact_from=null,source='user',detail={},force_new_cycle=false,config_update=null}={}){
  const p=await one(env.DB,`SELECT * FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const impact=impact_from||impactForEvidence(kind);
  const started=await one(env.DB,`SELECT 1 x FROM design_candidates WHERE project_id=? AND research_cycle=? LIMIT 1`,[projectId,Number(p.research_cycle||1)]);
  const fullCycle=!!started && (force_new_cycle||['define','measure','compute'].includes(impact));
  const nextRevision=Number(p.evidence_revision||0)+1,nextCycle=Number(p.research_cycle||1)+(fullCycle?1:0),ts=nowIso();
  if(fullCycle) await snapshot(env,p,`${kind}:${impact}`,nextRevision,nextCycle);
  const from=earlierStage(earlierStage(p.current_stage||impact,p.revalidation_from||impact),impact);
  await env.DB.batch([
    ...(config_update?[env.DB.prepare('UPDATE project_config SET design_json=?,constraints_json=?,benchmark_json=?,validation_json=? WHERE project_id=?').bind(JSON.stringify(config_update.design),JSON.stringify(config_update.constraints),JSON.stringify(config_update.benchmark),JSON.stringify(config_update.validation),projectId)]:[]),
    env.DB.prepare(`UPDATE projects SET evidence_revision=?,research_cycle=?,revalidation_from=?,approval_stale=1,last_evidence_at=?,status='revalidating',current_stage=?,reviewer_hold_marker=NULL,candidate_count=CASE WHEN ? THEN 0 ELSE candidate_count END,updated_at=? WHERE id=?`).bind(nextRevision,nextCycle,from,ts,from,fullCycle?1:0,ts,projectId),
    env.DB.prepare(`UPDATE approvals SET stale_at=COALESCE(stale_at,?),stale_reason=COALESCE(stale_reason,?) WHERE project_id=? AND stale_at IS NULL`).bind(ts,`${kind}:${impact}`,projectId),
    env.DB.prepare(`UPDATE reports SET stale_at=COALESCE(stale_at,?),stale_reason=COALESCE(stale_reason,?) WHERE project_id=? AND stale_at IS NULL`).bind(ts,`${kind}:${impact}`,projectId),
    env.DB.prepare(`INSERT INTO evidence_events(id,project_id,evidence_revision,research_cycle,evidence_kind,impact_from,source,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(uid('evidence'),projectId,nextRevision,nextCycle,String(kind||'UNKNOWN'),impact,String(source||''),JSON.stringify(detail||{}),ts)
  ]);
  if(fullCycle){
    await run(env.DB,`UPDATE jobs SET status='failed',last_error='superseded_by_evidence_revision',updated_at=? WHERE project_id=? AND status IN ('queued','running') AND type IN ('seed_candidates','compute_candidate','validate_project','fit_reviewer','recompute_project','finalize_recompute','approve_project','generate_report')`,[ts,projectId]);
  }
  // Human evidence reuses robust computation, but reviewer model + recompute must be refreshed.
  if(impact==='validate' && String(kind||'').toUpperCase()==='REVERIFICATION_REVIEW') await enqueueOnce(env,projectId,'validate_project',{},58,1);
  else if(impact==='validate') await enqueueOnce(env,projectId,'fit_reviewer',{},60,1);
  else if(impact==='measure') await enqueueOnce(env,projectId,'measure_project',{},30,1);
  else if(impact==='compute') await enqueueOnce(env,projectId,'seed_candidates',{},35,1);
  else await enqueueOnce(env,projectId,'define_project',{},10,1);
  bust(env,projectId);
  await audit(env,projectId,'agent','evidence.registered','project',projectId,{kind,impact,source,nextRevision,nextCycle,fullCycle,detail});
  return{evidence_revision:nextRevision,research_cycle:nextCycle,impact_from:impact,full_cycle:fullCycle};
}

export async function approvalGates(env,projectId){
  // One indexed statement replaces the former 7 D1 round-trips. EXISTS stops at the first hit.
  const g=await one(env.DB,`SELECT p.research_cycle,p.evidence_revision,p.approval_stale,p.revalidation_from,
    EXISTS(SELECT 1 FROM research_protocols rp WHERE rp.project_id=p.id AND rp.research_cycle=p.research_cycle LIMIT 1) protocol_ok,
    EXISTS(SELECT 1 FROM design_candidates c WHERE c.project_id=p.id AND c.research_cycle=p.research_cycle AND c.status='confirmed_feasible' LIMIT 1) compute_ok,
    EXISTS(SELECT 1 FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=p.id AND c.research_cycle=p.research_cycle AND v.validation_type='robust' AND v.status='CONFIRM' LIMIT 1) robust_ok,
    EXISTS(SELECT 1 FROM reviewer_models rm WHERE rm.project_id=p.id AND rm.research_cycle=p.research_cycle AND rm.evidence_revision=p.evidence_revision LIMIT 1) reviewer_ok,
    EXISTS(SELECT 1 FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=p.id AND c.research_cycle=p.research_cycle AND v.evidence_revision=p.evidence_revision AND v.validation_type='human_recompute' AND v.status='CONFIRM' LIMIT 1) recompute_ok,
    EXISTS(SELECT 1 FROM approvals a WHERE a.project_id=p.id AND a.research_cycle=p.research_cycle AND a.evidence_revision=p.evidence_revision AND a.decision='SCIENTIFICALLY_APPROVED' AND a.stale_at IS NULL LIMIT 1) signoff_ok
    FROM projects p WHERE p.id=?`,[projectId]);
  if(!g)return null;
  const cycle=Number(g.research_cycle||1),rev=Number(g.evidence_revision||0);
  const gates=[
    {id:'G1',name:'Protocol Frozen',status:Number(g.protocol_ok)?'PASS':'WAIT'},
    {id:'G2',name:'Compute Confirmed',status:Number(g.compute_ok)?'PASS':'WAIT'},
    {id:'G3',name:'Robust Validation',status:Number(g.robust_ok)?'PASS':'WAIT'},
    {id:'G4',name:'Human Validation',status:Number(g.reviewer_ok)?'PASS':'WAIT'},
    {id:'G5',name:'Recompute Confirmed',status:Number(g.recompute_ok)?'PASS':'WAIT'},
    {id:'G6',name:'Scientific Sign-off',status:Number(g.signoff_ok)?'PASS':'WAIT'}
  ];
  return{research_cycle:cycle,evidence_revision:rev,stale:!!g.approval_stale,revalidation_from:g.revalidation_from,gates,passed:gates.filter(x=>x.status==='PASS').length,total:gates.length};
}
