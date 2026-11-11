import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {enableOfficialConnector,collectOfficialSource} from '../src/lib/official_sources.js';

test('OpenFiscal retries transient upstream timeouts with extended bounded timeout', async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
 const env={DB,OPENFISCAL_API_KEY:'test'};
 await enableOfficialConnector(env,id,'openfiscal',{account_year:'2025'});
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async (_url,opts)=>{
   calls++;assert.ok(opts.signal);
   if(calls<3) throw new DOMException('timed out','TimeoutError');
   return new Response('<response><CODE>INFO-000</CODE><MESSAGE>정상 처리되었습니다.</MESSAGE><list_total_count>1</list_total_count><row><ACNT_YR>2025</ACNT_YR><BDG_FND_DIV_NM>일반회계</BDG_FND_DIV_NM><ACNT_DIV_NM>세입</ACNT_DIV_NM><SMOK_DIV_NM>내국세</SMOK_DIV_NM><SUM_NASS_TREV_BDG_AMT>100</SUM_NASS_TREV_BDG_AMT></row></response>',{status:200,headers:{'content-type':'application/xml'}});
 };
 try {const src=DB.raw.prepare("SELECT * FROM data_sources WHERE connector_id='openfiscal'").get();const result=await collectOfficialSource(env,id,src);assert.equal(calls,3);assert.equal(result.fetched,1);}
 finally {globalThis.fetch=old;}
});

test('BOJO retries transient HTTP 522 before parsing a successful response', async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
 const env={DB,BOJO_API_KEY:'test'};
 await enableOfficialConnector(env,id,'bojo_openapi',{endpoint_url:'https://apis.data.go.kr/1051000/MoefOpenAPI/T_OPD_PRMSCT_SBBGST?bsnsyear=2025',query:{numOfRows:1}});
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;if(calls===1)return new Response('gateway timeout',{status:522});return Response.json({response:{header:{resultCode:'00'},body:{pageNo:1,numOfRows:1,totalCount:1,items:{item:{REALM_CODE:'010',SECT_CODE:'011',BSNSYEAR:'2025',BGAMT:'123'}}}}});};
 try {const src=DB.raw.prepare("SELECT * FROM data_sources WHERE connector_id='bojo_openapi'").get();const result=await collectOfficialSource(env,id,src);assert.equal(calls,2);assert.equal(result.fetched,1);}
 finally {globalThis.fetch=old;}
});
