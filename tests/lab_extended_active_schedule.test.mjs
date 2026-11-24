import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {createLabCampaign,extendLabDeadline,nextTime,processLabTick,labApi} from '../src/lib/lab.js';
import {DEFAULT_DEADLINE} from '../src/lib/lab_policy.js';

const deadline='2027-01-30T14:59:59.000Z';
async function fixture(){const DB=makeDb(),pid=await seedProject(DB,{candidates:8,reviewer:35,episodes:12});const env={DB,pid,AI:{run:async()=>({response:JSON.stringify({summary:'Scholarly review assessed evidence boundaries.',findings:[],blockers:[],recommendations:[]})})}};await createLabCampaign(env,pid);return env;}
test('new campaigns default to January 30 2027 (KST end of day)',async()=>{
 assert.equal(DEFAULT_DEADLINE,deadline);
 const env=await fixture();assert.equal(env.DB.raw.prepare('SELECT deadline_at FROM lab_campaigns').get().deadline_at,deadline);
});
test('extending an existing deadline preserves work, original start time, and wakes immediately',async()=>{
 const env=await fixture(),db=env.DB.raw;
 db.prepare("UPDATE lab_campaigns SET deadline_at='2026-11-30T14:59:59.000Z',cursor=16,completed_tasks=16,next_run_at='2026-12-01T00:00:00.000Z'").run();
 const before=db.prepare('SELECT starts_at FROM lab_campaigns').get().starts_at;
 const campaign=db.prepare('SELECT * FROM lab_campaigns').get();
 const result=await extendLabDeadline(env,campaign,{deadline_at:deadline});
 const after=db.prepare('SELECT * FROM lab_campaigns').get();
 assert.equal(result.remaining_tasks,284);assert.equal(after.deadline_at,deadline);
 assert.equal(after.starts_at,before);assert.equal(after.cursor,16);assert.equal(after.completed_tasks,16);
 assert.ok(Date.parse(after.next_run_at)<=Date.now()+10000);
});
test('extension never steals an active Worker lease',async()=>{
 const env=await fixture(),db=env.DB.raw;db.prepare('UPDATE lab_campaigns SET lease_token=?,lease_until=?').run('live',new Date(Date.now()+60000).toISOString());
 await assert.rejects(extendLabDeadline(env,db.prepare('SELECT * FROM lab_campaigns').get(),{deadline_at:deadline}),/currently running/);
 assert.equal(db.prepare('SELECT lease_token FROM lab_campaigns').get().lease_token,'live');
});
test('next work follows a 15-minute ceiling rather than being spread over deadline',()=>{
 const now=Date.parse('2026-11-18T04:00:00Z');
 const c={starts_at:'2026-11-12T00:00:00Z',deadline_at:deadline,total_tasks:300};
 assert.equal(nextTime(c,17,now),'2026-11-18T04:15:00.000Z');
 assert.equal(nextTime(c,299,now),'2026-11-18T04:15:00.000Z');
});
test('early finalization rejects incomplete evidence without changing cursor or activity',async()=>{
 const env=await fixture(),db=env.DB.raw;
 const response=await labApi(new Request('https://example.test',{method:'POST'}),env,env.pid,['api','projects',env.pid,'lab','finalize']);
 assert.equal(response.status,409);const result=await response.json();assert.equal(result.error,'early_finalization_not_ready');assert.ok(result.blockers.length);
 const c=db.prepare('SELECT cursor,status,lease_token,package_id FROM lab_campaigns').get();
 assert.equal(c.cursor,0);assert.equal(c.status,'active');assert.equal(c.lease_token,null);assert.equal(c.package_id,null);
});
