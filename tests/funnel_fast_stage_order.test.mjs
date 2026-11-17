import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enqueue,claimJobs} from '../src/lib/db.js';

test('robust historical and stress tasks overtake queued exploration in GitHub hybrid', async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  const env={DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions'};
  await enqueue(env,id,'compute_candidate',{candidate_id:'a',phase:'exploration',cycle:0},40);
  await enqueue(env,id,'compute_candidate',{candidate_id:'b',phase:'confirmation',cycle:0},45);
  await enqueue(env,id,'compute_candidate',{candidate_id:'c',phase:'historical',cycle:0},48);
  await enqueue(env,id,'compute_candidate',{candidate_id:'c',phase:'stress',cycle:0},49);
  const claimed=await claimJobs(env,4);
  assert.deepEqual(claimed.map(j=>j.phase),['historical','stress','confirmation','exploration']);
});

test('legacy single-executor scheduling retains its existing priority contract', async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM jobs');
  const env={DB,COMPUTE_EXECUTOR:'github-actions',EXTERNAL_RUNTIME:'github-actions'};
  await enqueue(env,id,'compute_candidate',{candidate_id:'a',phase:'exploration'},40);
  await enqueue(env,id,'compute_candidate',{candidate_id:'b',phase:'stress'},49);
  const claimed=await claimJobs(env,2);
  assert.deepEqual(claimed.map(j=>j.phase),['exploration','stress']);
});
