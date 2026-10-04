import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enableOfficialConnector,officialSourceStatus} from '../src/lib/official_sources.js';
import {scheduleAll} from '../src/lib/orchestrator.js';
import {collectProject} from '../src/lib/collectors.js';
import {enqueueOnce} from '../src/lib/db.js';
test('official-only jobs advance through all enabled sources despite unrelated backlog and missing keys',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});const env={DB,COMPUTE_EXECUTOR:'hybrid',EXTERNAL_RUNTIME:'github-actions',MAX_JOBS_PER_TICK:1};
 for(const key of ['bis_cpmi','ecb_supervisory','bok_ecos','openfiscal','bojo_openapi'])await enableOfficialConnector(env,id,key);
 DB.raw.prepare("INSERT INTO data_sources(id,project_id,name,kind,url,enabled,cadence_minutes,created_at) VALUES('fdic',?,'other','fdic_sod','https://example.test',1,15,?)").run(id,new Date().toISOString());
 await enqueueOnce(env,id,'collect_project',{refresh:true},25);await scheduleAll(env,{process:false});
 const previous=globalThis.fetch;globalThis.fetch=async(url,opts)=>{if(String(url).includes('stats.bis.org'))assert.equal(opts.headers.Accept,'application/vnd.sdmx.data+csv;version=1.0.0');return new Response('TIME_PERIOD,OBS_VALUE\n2024,123',{headers:{'content-type':'text/csv'}});};
 try{for(let i=0;i<6;i++)await collectProject(env,id,{dueOnly:true});
 const status=await officialSourceStatus(env,id);assert.ok(status.sources.find(s=>s.connector_id==='bis_cpmi').coverage.rows>0);assert.ok(status.sources.find(s=>s.connector_id==='ecb_supervisory').coverage.rows>0);assert.match(status.sources.find(s=>s.connector_id==='bok_ecos').last_status,/ECOS_API_KEY_NOT_CONFIGURED/);assert.match(status.sources.find(s=>s.connector_id==='openfiscal').last_status,/OPENFISCAL_API_KEY_NOT_CONFIGURED/);assert.match(status.sources.find(s=>s.connector_id==='bojo_openapi').last_status,/BOJO_API_KEY_NOT_CONFIGURED/);assert.ok(DB.raw.prepare("SELECT COUNT(*) n FROM data_sources WHERE connector_id IS NOT NULL AND last_status IS NOT NULL").get().n>=4);
 }finally{globalThis.fetch=previous;}
});
