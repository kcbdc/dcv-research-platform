import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {enqueue,claimJobs,finishJob,recoverStaleJobs} from '../src/lib/db.js';
import {labCadence,nextTime} from '../src/lib/lab.js';
test('stale job owner cannot complete or retry a replacement claim',async()=>{
 const DB=makeDb(),env={DB};await enqueue(env,null,'test');const [old]=await claimJobs(env,1);
 DB.raw.prepare("UPDATE jobs SET status='queued',locked_at=NULL WHERE id=?").run(old.id);
 const [fresh]=await claimJobs(env,1);await finishJob(env,old);await finishJob(env,old,Error('old'));
 assert.equal(DB.raw.prepare('SELECT status FROM jobs WHERE id=?').get(old.id).status,'running');
 await finishJob(env,fresh);assert.equal(DB.raw.prepare('SELECT status FROM jobs WHERE id=?').get(old.id).status,'done');
});
test('stale recovery is isolated by database',async()=>{
 for(let i=0;i<2;i++){const DB=makeDb(),env={DB};await enqueue(env,null,'test');DB.raw.exec("UPDATE jobs SET status='running',locked_at='2000-01-01'");await recoverStaleJobs(env);assert.equal(DB.raw.prepare('SELECT status FROM jobs').get().status,'queued');}
});
test('configured lab cadence is four times shorter without changing deadline',()=>{
 const now=Date.parse('2026-11-24T00:00:00Z'),c={deadline_at:'2027-01-30T00:00:00Z'};
 assert.equal(labCadence({LAB_CADENCE_SECONDS:'225'}),225000);
 assert.equal((Date.parse(nextTime(c,1,now))-now)/(Date.parse(nextTime(c,1,now,225000))-now),4);
 assert.equal(labCadence({LAB_CADENCE_SECONDS:'0'}),900000);
});
