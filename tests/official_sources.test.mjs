import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { enableOfficialConnector, collectOfficialSource, officialSourceStatus, OFFICIAL_CONNECTORS, __test as officialTest } from '../src/lib/official_sources.js';
import { deriveBisDigitalMapping, deriveEcbResilienceMapping, officialValidationScenarios } from '../src/lib/official_mapping.js';

function seed(){const DB=makeDb(),now='2026-10-01T00:00:00.000Z';DB.raw.prepare(`INSERT INTO projects(id,name,description,status,current_stage,auto_run,auto_approve,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run('p','x','','draft','define',1,0,now,now);return DB;}

async function source(DB,id){return DB.prepare(`SELECT * FROM data_sources WHERE project_id='p' AND connector_id=?`).bind(id).first();}

test('Case A connector activation creates separate layer and official sources',async()=>{
  const DB=seed();
  await enableOfficialConnector({DB},'p','bis_cpmi');
  await enableOfficialConnector({DB},'p','ecb_supervisory');
  await enableOfficialConnector({DB},'p','bok_ecos');
  const st=await officialSourceStatus({DB},'p');
  assert.equal(st.layers.find(x=>x.layer_code==='A').enabled,1);
  assert.equal(st.sources.length,3);
  assert.ok(st.sources.every(x=>x.case_layer==='A'));
});

test('BIS CPMI SDMX CSV collector normalizes official observations and is change-aware',async()=>{
  const DB=seed(); await enableOfficialConnector({DB},'p','bis_cpmi',{series:[{key:'A.KR.N.A.A.Z.Z.A.A.Z.A.A',metric_code:'cpmi.volume',jurisdiction:'KR',unit_hint:'Millions'}],start_period:'2023'});const s=await source(DB,'bis_cpmi');const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response('FREQ,REPORTING_COUNTRY,TIME_PERIOD,OBS_VALUE,UNIT_MEASURE\nA,KR,2023,100,Millions\nA,KR,2024,120,Millions\n',{status:200,headers:{'content-type':'text/csv'}});
  try{const a=await collectOfficialSource({DB},'p',s);assert.equal(a.changed,2);const b=await collectOfficialSource({DB},'p',s);assert.equal(b.changed,0);assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM official_observations`).get().n,2);}finally{globalThis.fetch=old;}
});

test('ECB SUP connector imports LCR/CET1 SDMX CSV',async()=>{
  const DB=seed();await enableOfficialConnector({DB},'p','ecb_supervisory',{series:[{key:'Q.B01.W0._Z.I3017._T.SII._Z._Z._Z.PCT.C',metric_code:'ecb.lcr',jurisdiction:'SSM',unit_hint:'Percent'}]});const s=await source(DB,'ecb_supervisory'),old=globalThis.fetch;
  globalThis.fetch=async()=>new Response('KEY,TIME_PERIOD,OBS_VALUE,UNIT_MEASURE\nX,2025-Q4,158.6,Percent\n',{status:200,headers:{'content-type':'text/csv'}});
  try{const r=await collectOfficialSource({DB},'p',s);assert.equal(r.changed,1);const x=DB.raw.prepare(`SELECT * FROM official_observations WHERE metric_code='ecb.lcr'`).get();assert.equal(x.value_num,158.6);assert.equal(x.case_layer,'A');}finally{globalThis.fetch=old;}
});

test('ECOS connector uses secret and StatisticSearch row normalization',async()=>{
  const DB=seed();await enableOfficialConnector({DB},'p','bok_ecos',{stat_code:'722Y001',cycle:'D',start_period:'20261001',end_period:'20261001',item_code1:'0101000',metric_code:'ecos.base_rate'});const s=await source(DB,'bok_ecos'),old=globalThis.fetch;let called='';
  globalThis.fetch=async url=>{called=String(url);return new Response(JSON.stringify({StatisticSearch:{row:[{STAT_CODE:'722Y001',ITEM_CODE1:'0101000',ITEM_NAME1:'한국은행 기준금리',TIME:'20261001',DATA_VALUE:'2.50',UNIT_NAME:'%'}]}}),{status:200,headers:{'content-type':'application/json'}})};
  try{const r=await collectOfficialSource({DB,ECOS_API_KEY:'secret'},'p',s);assert.equal(r.changed,1);assert.match(called,/StatisticSearch\/secret\/json\/kr/);const x=DB.raw.prepare(`SELECT * FROM official_observations`).get();assert.equal(x.value_num,2.5);assert.equal(x.jurisdiction,'KR');}finally{globalThis.fetch=old;}
});

test('Case B dedicated OpenFiscal connector is READY by default and remains isolated from BOJO',async()=>{
  const DB=seed();await enableOfficialConnector({DB},'p','openfiscal');await enableOfficialConnector({DB},'p','bojo_openapi');const st=await officialSourceStatus({DB},'p');assert.equal(st.layers.find(x=>x.layer_code==='B').enabled,1);assert.equal(st.sources.find(x=>x.connector_id==='openfiscal').config.status,'READY');assert.equal(st.sources.find(x=>x.connector_id==='bojo_openapi').config.status,'READY');
  const src=await source(DB,'openfiscal');assert.equal(src.enabled,1);assert.equal(src.config_json.includes('OPFI156'),true);
});

test('OpenFiscal OPFI156 XML parser and collector preserve fiscal dimensions',async()=>{
  const DB=seed();await enableOfficialConnector({DB},'p','openfiscal',{account_year:'2025'});const src=await source(DB,'openfiscal'),old=globalThis.fetch;let called='';
  const xml=`<?xml version="1.0"?><OPFI156><head><list_total_count>2</list_total_count><RESULT><CODE>INFO-000</CODE><MESSAGE>정상 처리되었습니다.</MESSAGE></RESULT></head><row><ACNT_YR>2025</ACNT_YR><BDG_FND_DIV_NM>기금</BDG_FND_DIV_NM><ACNT_DIV_NM>기금</ACNT_DIV_NM><SMOK_DIV_NM>사회보험성기금</SMOK_DIV_NM><SUM_NASS_TREV_BDG_AMT>96.5</SUM_NASS_TREV_BDG_AMT></row><row><ACNT_YR>2025</ACNT_YR><BDG_FND_DIV_NM>예산</BDG_FND_DIV_NM><ACNT_DIV_NM>기업특별회계</ACNT_DIV_NM><SMOK_DIV_NM>세외수입</SMOK_DIV_NM><SUM_NASS_TREV_BDG_AMT>7.5</SUM_NASS_TREV_BDG_AMT></row></OPFI156>`;
  globalThis.fetch=async url=>{called=String(url);return new Response(xml,{status:200,headers:{'content-type':'application/xml'}})};
  try{const r=await collectOfficialSource({DB,OPENFISCAL_API_KEY:'secret'},'p',src);assert.equal(r.changed,2);assert.match(called,/OPFI156/);assert.match(called,/Key=secret/);assert.match(called,/ACNT_YR=2025/);const x=DB.raw.prepare(`SELECT * FROM official_observations WHERE metric_code='openfiscal.revenue.structure' ORDER BY value_num DESC LIMIT 1`).get();assert.equal(x.value_num,96.5);assert.match(x.series_key,/사회보험성기금/);assert.equal(x.period,'2025');assert.equal(r.meta.code,'INFO-000');}finally{globalThis.fetch=old;}
});

test('ECOS dedicated default resolves latest monthly END_TIME using StatisticItemList',async()=>{
  const DB=seed();await enableOfficialConnector({DB},'p','bok_ecos');const src=await source(DB,'bok_ecos'),old=globalThis.fetch;const calls=[];
  globalThis.fetch=async url=>{calls.push(String(url));if(String(url).includes('StatisticItemList'))return new Response(JSON.stringify({StatisticItemList:{row:[{STAT_CODE:'102Y004',ITEM_CODE:'ABA1',ITEM_NAME:'본원통화(평잔,계절조정계열)',CYCLE:'M',START_TIME:'200310',END_TIME:'202607',UNIT_NAME:'십억원'}]}}),{status:200,headers:{'content-type':'application/json'}});return new Response(JSON.stringify({StatisticSearch:{row:[{STAT_CODE:'102Y004',ITEM_CODE1:'ABA1',ITEM_NAME1:'본원통화(평잔,계절조정계열)',TIME:'202607',DATA_VALUE:'315000.1',UNIT_NAME:'십억원'}]}}),{status:200,headers:{'content-type':'application/json'}})};
  try{const r=await collectOfficialSource({DB,ECOS_API_KEY:'secret'},'p',src);assert.equal(r.changed,1);assert.ok(calls.some(x=>x.includes('StatisticItemList')));assert.ok(calls.some(x=>x.includes('/102Y004/M/200310/202607/ABA1')));assert.equal(r.meta.end_period,'202607');const x=DB.raw.prepare(`SELECT * FROM official_observations`).get();assert.equal(x.metric_code,'ecos.monetary_base.sa.avg');assert.equal(x.value_num,315000.1);}finally{globalThis.fetch=old;}
});

test('connector registry covers requested sequence',()=>{
  for(const id of ['bis_cpmi','ecb_supervisory','bok_ecos','openfiscal','bojo_openapi'])assert.ok(OFFICIAL_CONNECTORS[id],id);
  assert.equal(OFFICIAL_CONNECTORS.openfiscal.case_layer,'B');assert.equal(OFFICIAL_CONNECTORS.bis_cpmi.case_layer,'A');
});


test('BIS mapping produces D proxy components and sensitivity variants without replacing panel D',()=>{
  const rows=[
    {metric_code:'cpmi.cashless.volume.total',period:'2022',value_num:100},
    {metric_code:'cpmi.cashless.volume.total',period:'2023',value_num:120},
    {metric_code:'cpmi.cashless.volume.total',period:'2024',value_num:150},
    {metric_code:'cpmi.cashless.volume.fast',period:'2024',value_num:30}
  ];
  const m=deriveBisDigitalMapping(rows);assert.equal(m.status,'READY');assert.equal(m.mapping_key,'D_CPMI');assert.equal(m.components.historical_level_percentile,1);assert.equal(m.components.fast_payment_share,.2);assert.equal(m.value,.6);assert.deepEqual(Object.keys(m.sensitivity).sort(),['equal_weight','fast_only','level_only']);
});

test('ECB resilience mapping uses Basel LCR/CET1 headroom and maps only into declared theta range',()=>{
  const rows=[{metric_code:'ecb.sup.lcr.si',period:'2025-Q4',value_num:160},{metric_code:'ecb.sup.cet1.si',period:'2025-Q4',value_num:15}];
  const m=deriveEcbResilienceMapping(rows,.62,.74);assert.equal(m.status,'READY');assert.equal(m.mapping_key,'R_ECB');assert.ok(m.value>0&&m.value<1);assert.ok(m.theta_external>=.62&&m.theta_external<=.74);assert.equal(m.components.basel_lcr_minimum,100);assert.equal(m.components.basel_cet1_minimum,4.5);
});

test('official mappings become explicit CDRS stress scenarios rather than silently overwriting baseline parameters',async()=>{
  const DB=seed(),env={DB};const now='2026-10-01T00:00:00.000Z';
  DB.raw.prepare(`INSERT INTO external_validation_metrics(id,project_id,connector_id,mapping_key,method_version,period,value_num,components_json,sensitivity_json,payload_json,created_at,updated_at) VALUES('d','p','bis_cpmi','D_CPMI','BIS-CPMI-D-v1','2024',.6,'{}','{"level_only":1,"fast_only":0.2,"equal_weight":0.6}','{}',?,?)`).run(now,now);
  DB.raw.prepare(`INSERT INTO external_validation_metrics(id,project_id,connector_id,mapping_key,method_version,period,value_num,components_json,sensitivity_json,payload_json,created_at,updated_at) VALUES('r','p','ecb_supervisory','R_ECB','ECB-RESILIENCE-v1','2025-Q4',.5,'{}','{"lcr_only":0.67,"cet1_only":0.71,"equal_weight":0.69}','{}',?,?)`).run(now,now);
  const sc=await officialValidationScenarios(env,'p',{params:{baseline_shock:{value:.75},korea_concentration_anchor:{value:.75},korea_digital_adoption:{value:.92}},coeff:{kappa:-.0683,theta1:.0597,theta2:.2466,rmse:.03}});
  assert.equal(sc.filter(x=>x.external_mapping?.mapping_key==='D_CPMI').length,3);assert.equal(sc.filter(x=>x.external_mapping?.mapping_key==='R_ECB').length,3);assert.ok(sc.some(x=>x.digital===.2));assert.ok(sc.some(x=>x.risk_threshold_override===.69));
});

test('official observation upsert has O(1) read queries, not one SELECT per incoming row',async()=>{
  const DB=seed(),source={id:'s',connector_id:'bis_cpmi',case_layer:'A'},base=DB;DB.raw.prepare(`INSERT INTO data_sources(id,project_id,name,kind,url,method,headers_json,mapping_json,enabled,cadence_minutes,created_at,connector_id,case_layer,data_role,config_json,last_record_count) VALUES('s','p','x','official_connector','x','GET','{}','{}',1,60,'2026-10-01','bis_cpmi','A','digital_payments','{}',0)`).run();let reads=0;
  const wrapped={...base,prepare(sql){const st=base.prepare(sql),isRead=/^\s*select/i.test(sql);return{bind:(...b)=>{const q=st.bind(...b);return{first:async()=>{if(isRead)reads++;return q.first()},all:async()=>{if(isRead)reads++;return q.all()},run:()=>q.run(),_run:()=>q._run()}},first:async()=>{if(isRead)reads++;return st.first()},all:async()=>{if(isRead)reads++;return st.all()},run:()=>st.run(),_run:()=>st._run()};}};
  const rows=Array.from({length:120},(_,i)=>({jurisdiction:'KR',metric_code:'m',series_key:'k',period:String(1900+i),value_num:i,unit:'u',payload:{i}}));
  await officialTest.upsertObservations({DB:wrapped},'p',source,rows);assert.equal(reads,1);assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM official_observations`).get().n,120);
  reads=0;await officialTest.upsertObservations({DB:wrapped},'p',source,rows);assert.equal(reads,1,'unchanged re-sync must use one prefetch read regardless of row count');
});
