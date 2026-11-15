import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enableOfficialConnector,collectOfficialSource,officialSourceStatus} from '../src/lib/official_sources.js';

const fiscalXml='<response><CODE>INFO-000</CODE><list_total_count>1</list_total_count><row><ACNT_YR>2025</ACNT_YR><BDG_FND_DIV_NM>일반회계</BDG_FND_DIV_NM><ACNT_DIV_NM>세입</ACNT_DIV_NM><SMOK_DIV_NM>내국세</SMOK_DIV_NM><SUM_NASS_TREV_BDG_AMT>100</SUM_NASS_TREV_BDG_AMT></row></response>';
const bojoJson={response:{header:{resultCode:'00'},body:{pageNo:1,numOfRows:1,totalCount:1,items:{item:{REALM_CODE:'010',SECT_CODE:'011',BSNSYEAR:'2025',BGAMT:'123'}}}}};
for(const connector of ['openfiscal','bojo_openapi'])test(`${connector}: 522 retains verified coverage, records failure, then recovers`,async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});const env={DB,OPENFISCAL_API_KEY:'key',BOJO_API_KEY:'key'};
 await enableOfficialConnector(env,id,connector,connector==='openfiscal'?{account_year:'2025'}:{query:{bsnsyear:'2025',numOfRows:1}});
 const source=()=>DB.raw.prepare('SELECT * FROM data_sources WHERE connector_id=?').get(connector);
 const priorFetch=globalThis.fetch;
 let failure=false;
 globalThis.fetch=async()=>failure?new Response('Error code: 522',{status:522}):connector==='openfiscal'?new Response(fiscalXml):Response.json(bojoJson);
 try{
   const first=await collectOfficialSource(env,id,source());assert.equal(first.fetched,1);
   const before=DB.raw.prepare('SELECT COUNT(*) n FROM official_observations WHERE source_id=?').get(source().id).n;
   failure=true;
   const bad=await collectOfficialSource(env,id,source());assert.equal(bad.degraded,true);assert.equal(bad.cached,true);assert.equal(bad.error.code,'upstream_timeout');
   assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM official_observations WHERE source_id=?').get(source().id).n,before);
   assert.equal(source().last_record_count,1);assert.equal(source().last_status,'degraded:upstream_unavailable');
   assert.ok(source().next_fetch_at);
   const st=await officialSourceStatus(env,id);assert.equal(st.sources.find(x=>x.connector_id===connector).using_cached_data,true);
   failure=false;const after=await collectOfficialSource(env,id,source());assert.equal(after.degraded,undefined);
   assert.equal(source().last_status,'ok');
 }finally{globalThis.fetch=priorFetch;}
});
