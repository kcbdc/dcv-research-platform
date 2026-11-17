import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enqueueRobustValidation} from '../src/lib/compute.js';
import {scheduleAll} from '../src/lib/orchestrator.js';

// Archived simulation runs must never block the current revision's real work.
test('NA recovery enqueues historical/stress for confirmed candidates on a new evidence revision', async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.prepare("UPDATE design_candidates SET status='confirmed_feasible' WHERE id='cand_0'").run();
  DB.raw.prepare('UPDATE projects SET evidence_revision=5 WHERE id=?').run(pid);
  const now=new Date().toISOString();
  for(const phase of ['historical','stress'])DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,?,1,100,'{}',?,4)`).run('old_'+phase,pid,'cand_0',phase,now);
  const out=await enqueueRobustValidation({DB},pid);
  assert.equal(out.queued,2);
  const rows=DB.raw.prepare("SELECT phase,json_extract(payload_json,'$.candidate_id') id FROM jobs WHERE type='compute_candidate' ORDER BY phase").all();
  assert.deepEqual(rows.map(r=>r.phase),['historical','stress']);
  assert.ok(rows.every(r=>r.id==='cand_0'));
});

test('cron resumes an archived complete project when current revision robust gates are missing',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.prepare("UPDATE design_candidates SET status='confirmed_feasible' WHERE id='cand_0'").run();
  DB.raw.prepare('UPDATE projects SET evidence_revision=5 WHERE id=?').run(pid);
  await scheduleAll({DB,COMPUTE_EXECUTOR:'github-actions',EXTERNAL_RUNTIME:'github-actions'},{process:false});
  const j=DB.raw.prepare("SELECT 1 x FROM jobs WHERE type='advance_project' AND project_id=?").get(pid);
  assert.ok(j,'complete project should be scheduled if current-revision Historical/Stress are missing');
});

test('old-revision queued jobs do not suppress current-revision robust gates',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.prepare("UPDATE design_candidates SET status='confirmed_feasible' WHERE id='cand_0'").run();
  DB.raw.prepare('UPDATE projects SET evidence_revision=4025 WHERE id=?').run(pid);
  const env={DB};
  await (await import('../src/lib/db.js')).enqueue(env,pid,'compute_candidate',{candidate_id:'cand_0',phase:'historical',cycle:0,evidence_revision:773},48);
  const out=await enqueueRobustValidation(env,pid);
  assert.equal(out.queued,2);
  const rows=DB.raw.prepare("SELECT phase,json_extract(payload_json,'$.evidence_revision') rev FROM jobs WHERE type='compute_candidate' ORDER BY created_at,id").all();
  assert.equal(rows.filter(x=>x.rev===4025).length,2);
});

test('in-flight exploration does not block scheduling confirmed candidates robust gates',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:2,reviewer:0,episodes:0});
  DB.raw.prepare("UPDATE projects SET evidence_revision=4025,status='running' WHERE id=?").run(pid);
  DB.raw.prepare("UPDATE design_candidates SET status='confirmed_feasible' WHERE id='cand_0'").run();
  DB.raw.prepare("UPDATE design_candidates SET status='pending' WHERE id='cand_1'").run();
  const env={DB};
  await (await import('../src/lib/db.js')).enqueue(env,pid,'compute_candidate',{candidate_id:'cand_1',phase:'exploration',cycle:0,evidence_revision:4025},40);
  const result=await (await import('../src/lib/orchestrator.js')).advanceProject(env,pid);
  assert.equal(result.waiting,'jobs_in_flight');
  assert.equal(result.robust_queued,2);
  const rows=DB.raw.prepare("SELECT phase FROM jobs WHERE type='compute_candidate' AND phase IN ('historical','stress')").all();
  assert.deepEqual(rows.map(x=>x.phase).sort(),['historical','stress']);
});
