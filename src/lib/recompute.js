import { all, one, run, audit, enqueue, enqueueMany } from './db.js';
import { nowIso, uid, safeJson } from './util.js';
import { refreshValidationMatrix } from './validation_matrix.js';

export async function enqueueRecompute(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]); const cycle=Number(p?.research_cycle||1),rev=Number(p?.evidence_revision||0);
  const confirmed=await all(env.DB,`SELECT DISTINCT v.candidate_id id FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND c.research_cycle=? AND v.validation_type='robust' AND v.status='CONFIRM' ORDER BY v.candidate_id LIMIT 500`,[projectId,cycle]);
  await enqueueMany(env,projectId,'compute_candidate',confirmed.map(c=>({candidate_id:c.id,phase:'recompute',cycle:0})),70);   // 루프 안 개별 enqueue → 배치
  await audit(env,projectId,'agent','recompute.queued','project',projectId,{queued:confirmed.length,model:'empirical_reviewer',evidence_revision:rev});
  return{queued:confirmed.length};
}
export async function finalizeRecompute(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]); const cycle=Number(p?.research_cycle||1),rev=Number(p?.evidence_revision||0);
  const ids=await all(env.DB,`SELECT DISTINCT v.candidate_id id FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND c.research_cycle=? AND v.validation_type='robust' AND v.status='CONFIRM'`,[projectId,cycle]);
  // 후보마다 recompute 실행 1건을 조회하던 N+1 루프 → 프로젝트 단위 1회 조회 후 후보별 최신값 선택
  const runs=await all(env.DB,`SELECT candidate_id,result_json FROM simulation_runs WHERE project_id=? AND phase='recompute' AND evidence_revision=? ORDER BY created_at DESC`,[projectId,rev]);
  const latest=new Map(); for(const r of runs) if(!latest.has(r.candidate_id)) latest.set(r.candidate_id,r);
  let confirmed=0,rejected=0,hold=0; const stmts=[],ts=nowIso();
  for(const x of ids){
    const r=latest.get(x.id)||null;
    const ev=r?safeJson(r.result_json,{}):null;
    const status=!ev?'HOLD':ev.classification==='FEASIBLE'?'CONFIRM':ev.classification==='INFEASIBLE'?'REJECT':'HOLD';
    if(status==='CONFIRM')confirmed++;else if(status==='REJECT')rejected++;else hold++;
    stmts.push(env.DB.prepare(`INSERT INTO validations(id,project_id,candidate_id,validation_type,status,result_json,created_at,evidence_revision) VALUES(?,?,?,?,?,?,?,?)`).bind(uid('val'),projectId,x.id,'human_recompute',status,JSON.stringify({classification:ev?.classification||null,metrics:ev?.metrics||null,ci:ev?.ci||null,boundary_score:ev?.boundary_score||null,reviewer_used:ev?.reviewer_used||false}),ts,rev));
  }
  for(let i=0;i<stmts.length;i+=50)await env.DB.batch(stmts.slice(i,i+50));
  const result={confirmed,rejected,hold,total:ids.length};await refreshValidationMatrix(env,projectId);await audit(env,projectId,'agent','recompute.finalize','project',projectId,result);if(confirmed>0)await enqueue(env,projectId,'approve_project',{},90);return result;
}
