import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { enableOfficialConnector, collectDueOfficialSources, officialSourceStatus } from '../src/lib/official_sources.js';
import { enqueue, claimJobs } from '../src/lib/db.js';

function seed(){const DB=makeDb(),now='2026-10-01T00:00:00.000Z';DB.raw.prepare(`INSERT INTO projects(id,name,description,status,current_stage,auto_run,auto_approve,created_at,updated_at) VALUES('p','p','','active','define',0,0,?,?)`).run(now,now);return DB;}
const ecosFetch=u=>new Response(JSON.stringify(String(u).includes('StatisticItemList')?{StatisticItemList:{row:[{ITEM_CODE:'ABA1',CYCLE:'M',START_TIME:'200310',END_TIME:'202609',ITEM_NAME:'x',UNIT_NAME:'u'}]}}:{StatisticSearch:{row:[{STAT_CODE:'102Y004',ITEM_CODE1:'ABA1',TIME:'202609',DATA_VALUE:'1',UNIT_NAME:'u'}]}}));

test('official sources are collected on the Worker without a GitHub Actions runner',async()=>{
  const DB=seed(),old=globalThis.fetch;globalThis.fetch=async u=>ecosFetch(u);
  try{
    await enableOfficialConnector({DB},'p','bok_ecos');
    const env={DB,COMPUTE_EXECUTOR:'hybrid',ECOS_API_KEY:'k'};
    const r=await collectDueOfficialSources(env,{projectId:'p',limit:5,force:true});
    assert.equal(r.attempted.length,1);assert.equal(r.attempted[0].ok,true);assert.equal(r.attempted[0].inserted,1);
    const st=await officialSourceStatus(env,'p');
    assert.equal(st.sources[0].readiness,'ok');assert.equal(st.sources[0].coverage.rows,1);
  }finally{globalThis.fetch=old;}
});
test('a failed source reports the cause and is retried within 30 minutes, not after a full cadence',async()=>{
  const DB=seed(),old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({RESULT:{CODE:'INFO-100',MESSAGE:'bad key'}}));
  try{
    await enableOfficialConnector({DB},'p','bok_ecos');
    const r=await collectDueOfficialSources({DB,ECOS_API_KEY:'k'},{projectId:'p',force:true});
    assert.equal(r.attempted[0].ok,false);assert.equal(r.attempted[0].code,'invalid_api_key');
    const s=DB.raw.prepare(`SELECT last_status,next_fetch_at FROM data_sources WHERE connector_id='bok_ecos'`).get();
    assert.match(s.last_status,/^error:/);
    const mins=(Date.parse(s.next_fetch_at.replace(' ','T')+(s.next_fetch_at.endsWith('Z')?'':'Z'))-Date.now())/60000;
    assert.ok(mins<=31,`retry in ${mins} min`);
    const st=await officialSourceStatus({DB,ECOS_API_KEY:'k'},'p');
    assert.equal(st.sources[0].last_error.code,'invalid_api_key');
  }finally{globalThis.fetch=old;}
});
test('non-forced run only touches due sources',async()=>{
  const DB=seed(),old=globalThis.fetch;globalThis.fetch=async u=>ecosFetch(u);
  try{
    await enableOfficialConnector({DB},'p','bok_ecos');const env={DB,ECOS_API_KEY:'k'};
    assert.equal((await collectDueOfficialSources(env,{projectId:'p'})).processed,1);
    assert.equal((await collectDueOfficialSources(env,{projectId:'p'})).processed,0);
  }finally{globalThis.fetch=old;}
});
test('emergency flag lets the hybrid Worker claim a stranded collect_project; normal mode does not',async()=>{
  const DB=seed();const env={DB,COMPUTE_EXECUTOR:'hybrid'};
  await enqueue(env,'p','collect_project',{refresh:true},20);
  assert.equal((await claimJobs(env,4)).length,0);
  const em=Object.assign(Object.create(env),{EMERGENCY_WORKER_COMPUTE:'1'});
  const got=await claimJobs(em,4);assert.equal(got.length,1);assert.equal(got[0].type,'collect_project');
});
