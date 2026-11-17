import test from 'node:test';
import assert from 'node:assert/strict';
import {createD1Rest} from '../scripts/lib/d1-rest.mjs';
import {safeDiagnostic} from '../scripts/lib/runner-diagnostics.mjs';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {processJobs} from '../src/lib/orchestrator.js';

const cfg={accountId:'a'.repeat(32),databaseId:'12345678-1234-1234-1234-123456789abc',token:'test-only',intervalMs:0};
test('D1 REST 429 backs off using Retry-After and recovers without classifying as research failure',async()=>{
 let requests=0;const waits=[];
 const db=createD1Rest({...cfg,sleep:async ms=>{waits.push(ms)},fetchImpl:async()=>{
   requests++;if(requests<=2)return new Response('',{status:429,headers:{'retry-after':'1'}});
   return Response.json({success:true,result:[{success:true,results:[{x:1}],meta:{rows_read:1}}]});
 }});
 assert.equal((await db.prepare('SELECT 1 AS x').first()).x,1);
 assert.equal(requests,3);assert.equal(db.rowsRead,1);assert.ok(waits.filter(ms=>ms>=1500).length>=2);
});
test('exhausted 429 retries yield a safe D1_RATE_LIMITED diagnostic',async()=>{
 const db=createD1Rest({...cfg,sleep:async()=>{},fetchImpl:async()=>new Response('',{status:429})});
 await assert.rejects(db.prepare('SELECT 1').first(),e=>safeDiagnostic(e).code==='D1_RATE_LIMITED');
});
test('runner defers a claimed job on D1 429 without marking it failed',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
 DB.raw.prepare("INSERT INTO jobs(id,project_id,type,status,priority,payload_json,run_after,created_at,updated_at) VALUES('advance429',?,'advance_project','queued',1,'{}','2000','2000','2000')").run(id);
 const facade={...DB,withControl:async fn=>fn(),get remaining(){return 1000;},prepare(sql){
    if(sql.includes('SELECT * FROM projects WHERE id=?')){const stmt=DB.prepare(sql);return {bind:(...args)=>({first:async()=>{throw Object.assign(new Error('throttle'),{code:'D1_RATE_LIMITED'})}})};}
    return DB.prepare(sql);
 }};
 // Call processJobs with an injected failure on a work-path query.
 const result=await processJobs({DB:facade,EXTERNAL_RUNTIME:'github-actions',COMPUTE_EXECUTOR:'github-actions',MAX_JOBS_PER_TICK:1});
 assert.equal(result[0]?.deferred,true);assert.equal(result[0]?.reason,'d1_rate_limited');
 const job=DB.raw.prepare('SELECT status,attempts,last_error FROM jobs WHERE id=?').get('advance429');
 assert.equal(job.status,'queued');assert.equal(job.attempts,0);assert.equal(job.last_error,'deferred_d1_rate_limit');
});
