import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {computeCandidate,simulationUnitId,enqueueRobustValidation} from '../src/lib/compute.js';
import {bust} from '../src/lib/memo.js';

test('robust simulation IDs are distinct per evidence revision, while frozen exploration identity is stable',()=>{
  assert.notEqual(simulationUnitId('cand_1','historical',0,4),simulationUnitId('cand_1','historical',0,5));
  assert.notEqual(simulationUnitId('cand_1','stress',0,4),simulationUnitId('cand_1','stress',0,5));
  assert.notEqual(simulationUnitId('cand_1','recompute',0,4),simulationUnitId('cand_1','recompute',0,5));
  assert.equal(simulationUnitId('cand_1','exploration',0,4),simulationUnitId('cand_1','exploration',0,5));
  assert.equal(simulationUnitId('cand_1','confirmation',0,4),simulationUnitId('cand_1','confirmation',0,5));
});

test('revalidated historical evidence inserts new real data without deleting old revision results',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  const def={research_question:'test',design:{max_candidates:1},constraints:{loss_max:10,loss_exceed_max:1,fp_max:1,fn_max:1,review_burden_max:1,recovery_time_max:100,confidence:.95},benchmark:{horizon:10},validation:{exploration_n:10,confirmation_n:10,robust_n:10}};
  DB.raw.prepare('UPDATE definitions SET content_json=?').run(JSON.stringify(def));
  DB.raw.exec("DELETE FROM simulation_runs; DELETE FROM validations; UPDATE projects SET status='running',evidence_revision=4; UPDATE design_candidates SET status='confirmed_feasible'");
  const env={DB,COMPUTE_EXECUTOR:'github-actions',EXTERNAL_RUNTIME:'github-actions'};
  const first=await computeCandidate(env,pid,'cand_0','historical',0);
  const firstRow=DB.raw.prepare('SELECT evidence_revision,result_json FROM simulation_runs WHERE id=?').get(first.id);
  assert.equal(firstRow.evidence_revision,4);
  DB.raw.exec('UPDATE projects SET evidence_revision=5');bust(env,pid);
  const next=await computeCandidate(env,pid,'cand_0','historical',0);
  assert.notEqual(next.id,first.id);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM simulation_runs WHERE phase='historical'").get().n,2);
  assert.equal(DB.raw.prepare('SELECT result_json FROM simulation_runs WHERE id=?').get(first.id).result_json,firstRow.result_json);
  const rerun=await computeCandidate(env,pid,'cand_0','historical',0);
  assert.equal(rerun.id,next.id);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM simulation_runs WHERE phase='historical'").get().n,2);
});

test('robust queue does not schedule a phase whose current revision result exists',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec("UPDATE projects SET evidence_revision=5; UPDATE design_candidates SET status='confirmed_feasible'");
  DB.raw.prepare("INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,?,1,10,'{}',?,5)")
    .run('current_hist',pid,'cand_0','historical',new Date().toISOString());
  const result=await enqueueRobustValidation({DB},pid);
  assert.equal(result.queued,1);
  assert.deepEqual(DB.raw.prepare("SELECT phase FROM jobs WHERE type='compute_candidate'").all().map(x=>x.phase),['stress']);
});

test('validation does not confirm a candidate from stale historical/stress runs',async()=>{
  const {validateProject}=await import('../src/lib/validate.js');
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec("UPDATE projects SET evidence_revision=5,status='running'; UPDATE design_candidates SET status='confirmed_feasible'");
  const result=JSON.stringify({classification:'FEASIBLE',scenario_scores:{case_1:{objective:0.1}},metrics:{loss_mean:0.1}});
  for(const phase of ['confirmation','historical','stress']){
    DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,?,1,10,?,?,4)`)
      .run('old_only_'+phase,pid,'cand_0',phase,result,new Date().toISOString());
  }
  const out=await validateProject({DB},pid);
  assert.equal(out.confirmed,0);
  const record=DB.raw.prepare("SELECT status,result_json FROM validations WHERE validation_type='robust' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(record.status,'HOLD');
  const details=JSON.parse(record.result_json);
  assert.equal(details.historical,null);
  assert.equal(details.stress,null);
});
