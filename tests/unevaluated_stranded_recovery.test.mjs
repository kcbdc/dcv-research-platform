import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {advanceProject} from '../src/lib/orchestrator.js';
import {nowIso} from '../src/lib/util.js';

function envFor(DB){return {DB,COMPUTE_EXECUTOR:'github-actions',EXTERNAL_RUNTIME:'github-actions',MAX_JOBS_PER_TICK:1};}
function setup(candidates=1){
  const DB=makeDb();
  return seedProject(DB,{candidates,reviewer:0,episodes:0}).then(id=>{
    DB.raw.exec("DELETE FROM jobs; DELETE FROM simulation_runs; UPDATE projects SET status='running', auto_run=1; UPDATE design_candidates SET status='pending';");
    return {DB,id};
  });
}
function failedJob(DB,id,jobId,err,cand='cand_0'){
  const ts=nowIso();
  DB.raw.prepare("INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at,last_error) VALUES(?,?,'compute_candidate','failed',40,?,'exploration',?,?,?,?)")
    .run(jobId,id,JSON.stringify({candidate_id:cand,phase:'exploration',cycle:0}),ts,ts,ts,err);
}
const queuedFor=(DB,id)=>DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=? AND type='compute_candidate' AND status='queued'").get(id).n;

test('pending candidate that already has an exploration run (job died before status UPDATE) is re-queued',async()=>{
  const {DB,id}=await setup(1);
  const proj=DB.raw.prepare('SELECT research_cycle,evidence_revision FROM projects WHERE id=?').get(id);
  DB.raw.prepare("INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('run_x',?,'cand_0','exploration',1,10,'{}',?,?)")
    .run(id,nowIso(),proj.evidence_revision);
  const out=await advanceProject(envFor(DB),id);
  assert.equal(out.queued,1,'stranded candidate must be re-queued so UNEVALUATED can fall');
  assert.equal(queuedFor(DB,id),1);
});

test('transient rate-limit failures do not permanently abandon a pending candidate',async()=>{
  const {DB,id}=await setup(1);
  failedJob(DB,id,'f1','Error: D1_RATE_LIMITED');
  failedJob(DB,id,'f2','HTTP 429 (Cloudflare 7429)');
  failedJob(DB,id,'f3','stale_lock_recovered');
  const out=await advanceProject(envFor(DB),id);
  assert.equal(out.queued,1);
});

test('three permanent failures still stop retries',async()=>{
  const {DB,id}=await setup(1);
  failedJob(DB,id,'f1','Error: candidate_not_found');
  failedJob(DB,id,'f2','Error: candidate_not_found');
  failedJob(DB,id,'f3','Error: candidate_not_found');
  const out=await advanceProject(envFor(DB),id);
  assert.equal(out.queued,0);
  assert.equal(out.waiting,'inspect_failed_jobs');
});

test('pending candidate with a queued job is not duplicated',async()=>{
  const {DB,id}=await setup(1);
  const ts=nowIso();
  DB.raw.prepare("INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at) VALUES('q1',?,'compute_candidate','queued',40,?,'exploration',?,?,?)")
    .run(id,JSON.stringify({candidate_id:'cand_0',phase:'exploration',cycle:0}),ts,ts,ts);
  await advanceProject(envFor(DB),id);
  assert.equal(queuedFor(DB,id),1);
});

test('drifted pending counter is repaired from the authoritative table when nothing can be queued',async()=>{
  const {DB,id}=await setup(1);
  failedJob(DB,id,'f1','Error: candidate_not_found');failedJob(DB,id,'f2','Error: candidate_not_found');failedJob(DB,id,'f3','Error: candidate_not_found');
  DB.raw.prepare("UPDATE project_cycle_stats SET candidate_pending=5 WHERE project_id=?").run(id);
  const out=await advanceProject(envFor(DB),id);
  assert.equal(out.stats_repaired,true);
  assert.equal(DB.raw.prepare("SELECT candidate_pending p FROM project_cycle_stats WHERE project_id=?").get(id).p,1);
});
