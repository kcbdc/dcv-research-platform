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
