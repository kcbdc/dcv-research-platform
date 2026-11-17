import { all, one, run, audit, enqueue } from './db.js';
import { latestDefinition } from './define.js';
import { nowIso, uid, safeJson } from './util.js';
import { computeRegretTable } from './compute.js';
import { refreshValidationMatrix } from './validation_matrix.js';

function latestPhaseEvidence(rows,phase){
  const x=rows.find(r=>r.phase===phase); return x?safeJson(x.result_json,{}):null;
}
export async function validateProject(env,projectId){
  const def=await latestDefinition(env,projectId); if(!def)throw new Error('definition_missing');
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]); const cycle=Number(p?.research_cycle||1),rev=Number(p?.evidence_revision||0);
  const cands=await all(env.DB,`SELECT * FROM design_candidates WHERE project_id=? AND research_cycle=?`,[projectId,cycle]);
  // 후보마다 simulation_runs 를 조회하던 N+1 루프(128회) → 1회 조회. 후회표 계산에도 같은 행을 재사용한다.
  // Confirmation belongs to the frozen protocol; Historical/Stress must be
  // from the CURRENT evidence revision. Never confirm with old-revision outcomes.
  const allRuns=await all(env.DB,`SELECT candidate_id,phase,result_json FROM simulation_runs
    WHERE project_id=? AND (phase='confirmation' OR (phase IN ('historical','stress') AND evidence_revision=?))
    ORDER BY created_at DESC`,[projectId,rev]);
  const runsByCand=new Map(); for(const r of allRuns){ let a=runsByCand.get(r.candidate_id); if(!a){a=[];runsByCand.set(r.candidate_id,a);} a.push(r); }
  const regret=await computeRegretTable(env,projectId,allRuns); const regretMap=Object.fromEntries(regret.map(x=>[x.candidate_id,x]));
  let confirmed=0,boundary=0,rejected=0; const inserts=[];
  for(const cand of cands){
    const runs=runsByCand.get(cand.id)||[];
    const conf=latestPhaseEvidence(runs,'confirmation'),hist=latestPhaseEvidence(runs,'historical'),stress=latestPhaseEvidence(runs,'stress');
    let status='HOLD',reason='incomplete';
    if(cand.status==='infeasible'||cand.status==='confirmation_failed'){status='REJECT';reason='pre_robust_failure';}
    else if(cand.status==='boundary_hold'||cand.evidence_status==='UNRESOLVED'){status='HOLD';reason='statistically_unresolved';}
    else if(conf&&hist&&stress){
      const classes=[conf.classification,hist.classification,stress.classification];
      if(classes.every(x=>x==='FEASIBLE')){status='CONFIRM';reason='all_robust_phases_confirmed';}
      else if(classes.some(x=>x==='INFEASIBLE')){status='REJECT';reason='robust_constraint_violation';}
      else {status='HOLD';reason='robust_boundary_unresolved';}
    }
    const rg=regretMap[cand.id]||null;
    inserts.push(env.DB.prepare(`INSERT INTO validations(id,project_id,candidate_id,validation_type,status,result_json,created_at,evidence_revision) VALUES(?,?,?,?,?,?,?,?)`).bind(
      uid('val'),projectId,cand.id,'robust',status,JSON.stringify({reason,max_regret:rg?.max_regret??null,mean_regret:rg?.mean_regret??null,confirmation:conf?{classification:conf.classification,metrics:conf.metrics,ci:conf.ci}:null,historical:hist?{classification:hist.classification,metrics:hist.metrics,ci:hist.ci,scenario_scores:hist.scenario_scores}:null,stress:stress?{classification:stress.classification,metrics:stress.metrics,ci:stress.ci,scenario_scores:stress.scenario_scores}:null}),nowIso(),rev
    ));
    if(status==='CONFIRM')confirmed++; else if(status==='HOLD')boundary++; else rejected++;
  }
  for(let i=0;i<inserts.length;i+=50)await env.DB.batch(inserts.slice(i,i+50));   // 후보당 개별 INSERT 왕복 → 50건 배치
  const result={confirmed,boundary,rejected,total:cands.length,minimax_candidate:regret[0]||null};
  await refreshValidationMatrix(env,projectId);
  await audit(env,projectId,'agent','validate.robust.complete','project',projectId,result);
  const rm=await one(env.DB,`SELECT id FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? LIMIT 1`,[projectId,cycle,rev]);
  if(rm&&confirmed>0)await enqueue(env,projectId,'recompute_project',{},65); else if(confirmed>0)await enqueue(env,projectId,'fit_reviewer',{},60);
  return result;
}
export async function bestConfirmedCandidate(env,projectId,validationType='robust'){
  return one(env.DB,`SELECT c.*,v.result_json FROM design_candidates c
    JOIN projects p ON p.id=c.project_id
    JOIN validations v ON v.candidate_id=c.id AND v.evidence_revision=p.evidence_revision
    WHERE c.project_id=? AND c.research_cycle=p.research_cycle AND v.validation_type=? AND v.status='CONFIRM'
    ORDER BY COALESCE(c.max_regret,999999) ASC, c.authority_k DESC, c.sigma DESC LIMIT 1`,[projectId,validationType]);
}
