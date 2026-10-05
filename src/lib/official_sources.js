import { all, one, run, audit } from './db.js';
import { nowIso, uid, safeJson } from './util.js';
import { refreshOfficialMappings, getOfficialMappings } from './official_mapping.js';

export const OFFICIAL_CONNECTORS={
  bis_cpmi:{id:'bis_cpmi',name:'BIS CPMI Red Book — Retail Payments',case_layer:'A',data_role:'digital_payments',kind:'official_connector',cadence_minutes:10080,url:'https://stats.bis.org/api/v2',requires_secret:false,default_config:{dataset:'WS_CPMI_CASHLESS',agency:'BIS',version:'1.0',start_period:'2012',series:[
    {key:'A.KR.N.A.A.Z.Z.A.A.Z.A.A',metric_code:'cpmi.cashless.volume.total',jurisdiction:'KR',unit_hint:'million transactions'},
    {key:'A.KR.V.A.A.Z.Z.A.A.Z.A.A',metric_code:'cpmi.cashless.value.total',jurisdiction:'KR',unit_hint:'reported currency'},
    {key:'A.KR.N.A.A.Z.Z.A.A.A.F.A',metric_code:'cpmi.cashless.volume.fast',jurisdiction:'KR',unit_hint:'million transactions'}
  ]}},
  ecb_supervisory:{id:'ecb_supervisory',name:'ECB Supervisory Banking Statistics',case_layer:'A',data_role:'bank_resilience',kind:'official_connector',cadence_minutes:10080,url:'https://data-api.ecb.europa.eu/service/data/SUP',requires_secret:false,default_config:{start_period:'2015-Q1',series:[
    {key:'Q.B01.W0._Z.I3017._T.SII._Z._Z._Z.PCT.C',metric_code:'ecb.sup.lcr.si',jurisdiction:'SSM',unit_hint:'Percent'},
    {key:'Q.B01.W0._Z.I4008._T.SII._Z._Z._Z.PCT.C',metric_code:'ecb.sup.cet1.si',jurisdiction:'SSM',unit_hint:'Percent'}
  ]}},
  bok_ecos:{id:'bok_ecos',name:'한국은행 ECOS Open API · 102Y004',case_layer:'A',data_role:'korea_payments_macro',kind:'official_connector',cadence_minutes:1440,url:'https://ecos.bok.or.kr/api',requires_secret:true,secret_name:'ECOS_API_KEY',default_config:{status:'READY',stat_code:'102Y004',cycle:'M',start_period:'200310',end_period:'latest',item_code1:'ABA1',metric_code:'ecos.monetary_base.sa.avg',jurisdiction:'KR'}},
  openfiscal:{id:'openfiscal',name:'열린재정 OPFI156 · 재정수입구조',case_layer:'B',data_role:'public_fiscal_context',kind:'official_connector',cadence_minutes:1440,url:'https://openapi.openfiscaldata.go.kr/OPFI156',requires_secret:true,secret_name:'OPENFISCAL_API_KEY',default_config:{status:'READY',endpoint_url:'https://openapi.openfiscaldata.go.kr/OPFI156',auth_query_name:'Key',response_type:'xml',account_year:'latest',page_size:1000,metric_code:'openfiscal.revenue.structure',period_path:'ACNT_YR',value_path:'SUM_NASS_TREV_BDG_AMT',series_key_fields:['BDG_FND_DIV_NM','ACNT_DIV_NM','SMOK_DIV_NM'],unit:'source_reported',jurisdiction:'KR'}},
  bojo_openapi:{id:'bojo_openapi',name:'보조금통합포털(e나라도움) Open API',case_layer:'B',data_role:'subsidy_execution',kind:'official_connector',cadence_minutes:1440,url:'https://www.bojo.go.kr',requires_secret:true,secret_name:'BOJO_API_KEY',default_config:{status:'READY',endpoint_url:'https://apis.data.go.kr/1051000/MoefOpenAPI/T_OPD_PRMSCT_SBBGST',auth_query_name:'serviceKey',rows_path:'response.body.items.item',metric_code:'bojo.budget.by_sector',period_path:'BSNSYEAR',value_path:'BGAMT',series_key_fields:['REALM_CODE','SECT_CODE'],query:{resultType:'json',bsnsyear:'2021',pageNo:1,numOfRows:10},unit:'source_reported_budget_unit',jurisdiction:'KR'}}
};

function csvRows(text){
  const rows=[];let row=[],cur='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(q&&text[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===','&&!q){row.push(cur);cur='';}else if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cur);cur='';if(row.some(x=>x!==''))rows.push(row);row=[];}else cur+=c;}
  if(cur||row.length){row.push(cur);rows.push(row);} if(rows.length<2)return [];
  const h=rows[0].map(x=>x.trim()); return rows.slice(1).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??''])));
}
function pathGet(o,p){if(!p)return o;return String(p).split('.').reduce((a,k)=>a?.[k],o);}
function num(v){if(v==null||String(v).trim()==='')return null;const n=Number(String(v).replace(/,/g,''));return Number.isFinite(n)?n:null;}
function pick(row,names){for(const n of names)if(row?.[n]!=null&&row[n]!=='')return row[n];return null;}
function sdmxPeriod(row){return String(pick(row,['TIME_PERIOD','TIME','time_period','Period'])||'');}
function sdmxValue(row){return num(pick(row,['OBS_VALUE','value','Value','DATA_VALUE']));}
function sdmxUnit(row,hint=''){return String(pick(row,['UNIT_MEASURE','UNIT','UNIT_NAME','unit'])||hint||'');}

async function responseText(url,opts={}){const r=await fetch(url,{...opts,signal:opts.signal||AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`HTTP ${r.status} ${new URL(url).hostname}`);return {text:await r.text(),ct:r.headers.get('content-type')||'',status:r.status};}

function bisUrl(cfg,s){const q=new URLSearchParams();if(cfg.start_period)q.set('startPeriod',cfg.start_period);if(cfg.end_period)q.set('endPeriod',cfg.end_period);return `https://stats.bis.org/api/v2/data/dataflow/${encodeURIComponent(cfg.agency||'BIS')}/${encodeURIComponent(cfg.dataset||'WS_CPMI_CASHLESS')}/${encodeURIComponent(cfg.version||'1.0')}/${s.key}${q.size?'?'+q:''}`;}
async function collectBis(cfg){
  const out=[]; for(const s of cfg.series||[]){const {text}=await responseText(bisUrl(cfg,s),{headers:{Accept:'application/vnd.sdmx.data+csv;version=1.0.0'}});const rows=csvRows(text);for(const r of rows){const period=sdmxPeriod(r),v=sdmxValue(r);if(!period||v==null)continue;out.push({jurisdiction:s.jurisdiction||pick(r,['REPORTING_COUNTRY','REF_AREA'])||null,metric_code:s.metric_code||'bis.series',series_key:s.key,period,value_num:v,unit:sdmxUnit(r,s.unit_hint),dimensions:r,payload:r});}}
  return out;
}
function ecbUrl(cfg,s){const q=new URLSearchParams({format:'csvdata'});if(cfg.start_period)q.set('startPeriod',cfg.start_period);if(cfg.end_period)q.set('endPeriod',cfg.end_period);return `https://data-api.ecb.europa.eu/service/data/SUP/${s.key}?${q}`;}
async function collectEcb(cfg){
  const out=[];for(const s of cfg.series||[]){const {text}=await responseText(ecbUrl(cfg,s),{headers:{Accept:'text/csv'}});for(const r of csvRows(text)){const period=sdmxPeriod(r),v=sdmxValue(r);if(!period||v==null)continue;out.push({jurisdiction:s.jurisdiction||pick(r,['REF_AREA'])||null,metric_code:s.metric_code||'ecb.sup.series',series_key:s.key,period,value_num:v,unit:sdmxUnit(r,s.unit_hint),dimensions:r,payload:r});}}return out;
}
function ecosItemListUrl(key,cfg){return `https://ecos.bok.or.kr/api/StatisticItemList/${encodeURIComponent(key)}/json/kr/1/10/${encodeURIComponent(cfg.stat_code)}`;}
async function resolveEcosPeriods(key,cfg){
  if(cfg.end_period&&cfg.end_period!=='latest'&&cfg.start_period)return cfg;
  const {text}=await responseText(ecosItemListUrl(key,cfg));const j=JSON.parse(text);if(j.RESULT)throw new Error(`ECOS_ITEM:${j.RESULT.CODE}:${j.RESULT.MESSAGE}`);
  const rows=j.StatisticItemList?.row||[],hit=rows.find(r=>String(r.ITEM_CODE)===String(cfg.item_code1)&&String(r.CYCLE)===String(cfg.cycle))||rows.find(r=>String(r.ITEM_CODE)===String(cfg.item_code1));
  if(!hit)throw new Error('ECOS_ITEM_NOT_FOUND');return {...cfg,start_period:cfg.start_period||hit.START_TIME,end_period:cfg.end_period&&cfg.end_period!=='latest'?cfg.end_period:hit.END_TIME,item_name:hit.ITEM_NAME||cfg.item_name,unit_hint:hit.UNIT_NAME||cfg.unit_hint};
}
function ecosUrl(key,cfg){const seg=[cfg.stat_code,cfg.cycle,cfg.start_period,cfg.end_period,cfg.item_code1,cfg.item_code2,cfg.item_code3,cfg.item_code4].filter((x,i)=>i<4||(x!=null&&x!==''));return `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/${Number(cfg.limit||1000)}/${seg.map(x=>encodeURIComponent(x)).join('/')}`;}
async function collectEcos(env,cfg){const key=secretValue(env,'ECOS_API_KEY');if(!key)throw new Error('ECOS_API_KEY_NOT_CONFIGURED');const resolved=await resolveEcosPeriods(key,cfg);const {text}=await responseText(ecosUrl(key,resolved));const j=JSON.parse(text);if(j.RESULT)throw new Error(`ECOS:${j.RESULT.CODE}:${j.RESULT.MESSAGE}`);const rows=j.StatisticSearch?.row||[];const out=rows.map(r=>({jurisdiction:resolved.jurisdiction||'KR',metric_code:resolved.metric_code||`ecos.${r.STAT_CODE}`,series_key:[r.STAT_CODE,r.ITEM_CODE1,r.ITEM_CODE2,r.ITEM_CODE3,r.ITEM_CODE4].filter(Boolean).join(':'),period:String(r.TIME||''),value_num:num(r.DATA_VALUE),unit:String(r.UNIT_NAME||resolved.unit_hint||''),dimensions:r,payload:r})).filter(x=>x.period&&x.value_num!=null);return {rows:out,meta:{stat_code:resolved.stat_code,item_code:resolved.item_code1,item_name:resolved.item_name||null,cycle:resolved.cycle,start_period:resolved.start_period,end_period:resolved.end_period,total:out.length}};}
function xmlDecode(s=''){return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
function xmlTag(block,tag){const m=String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));return m?xmlDecode(m[1].trim()):'';}
function parseOpenFiscalXml(text){const root=String(text);const code=xmlTag(root,'CODE'),message=xmlTag(root,'MESSAGE'),total=Number(xmlTag(root,'list_total_count')||0);const rows=[...root.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gi)].map(m=>({ACNT_YR:xmlTag(m[1],'ACNT_YR'),BDG_FND_DIV_NM:xmlTag(m[1],'BDG_FND_DIV_NM'),ACNT_DIV_NM:xmlTag(m[1],'ACNT_DIV_NM'),SMOK_DIV_NM:xmlTag(m[1],'SMOK_DIV_NM'),SUM_NASS_TREV_BDG_AMT:xmlTag(m[1],'SUM_NASS_TREV_BDG_AMT')}));return {code,message,total,rows};}
function openFiscalUrl(key,cfg,year,page=1){const u=new URL(cfg.endpoint_url||'https://openapi.openfiscaldata.go.kr/OPFI156');u.searchParams.set(cfg.auth_query_name||'Key',key);u.searchParams.set('Type',cfg.response_type||'xml');u.searchParams.set('pIndex',String(page));u.searchParams.set('pSize',String(Math.min(1000,Number(cfg.page_size||1000))));u.searchParams.set('ACNT_YR',String(year));return u.toString();}
async function collectOpenFiscal(env,cfg){const key=secretValue(env,'OPENFISCAL_API_KEY');if(!key)throw new Error('OPENFISCAL_API_KEY_NOT_CONFIGURED');const nowY=new Date().getUTCFullYear(),years=cfg.account_year&&cfg.account_year!=='latest'?[Number(cfg.account_year)]:[nowY,nowY-1,nowY-2];let selected=null,meta=null;
  for(const y of years){const first=await responseText(openFiscalUrl(key,cfg,y,1));const parsed=parseOpenFiscalXml(first.text);if(parsed.code&&parsed.code!=='INFO-000'){if(parsed.code==='INFO-200'||/해당하는 데이터가 없습니다/.test(parsed.message))continue;throw new Error(`OPENFISCAL:${parsed.code}:${parsed.message}`);}if(!parsed.rows.length)continue;let rows=[...parsed.rows],page=1,size=Math.min(1000,Number(cfg.page_size||1000));while(rows.length<parsed.total){page++;if(page>100)throw new Error('OPENFISCAL_PAGINATION_LIMIT');const nxt=parseOpenFiscalXml((await responseText(openFiscalUrl(key,cfg,y,page))).text);if(nxt.code&&nxt.code!=='INFO-000')throw new Error(`OPENFISCAL:${nxt.code}:${nxt.message}`);if(!nxt.rows.length)break;rows.push(...nxt.rows);if(nxt.rows.length<size&&rows.length>=nxt.total)break;}selected=rows;meta={code:parsed.code||'INFO-000',message:parsed.message||'정상 처리되었습니다.',total:parsed.total||rows.length,year:String(y),pages:page};break;}
  if(!selected)throw new Error('OPENFISCAL:NO_DATA_FOR_LATEST_YEARS');const fields=cfg.series_key_fields||['BDG_FND_DIV_NM','ACNT_DIV_NM','SMOK_DIV_NM'];const rows=selected.map(r=>{const period=String(r.ACNT_YR||''),v=num(r.SUM_NASS_TREV_BDG_AMT);return {jurisdiction:cfg.jurisdiction||'KR',metric_code:cfg.metric_code||'openfiscal.revenue.structure',series_key:['OPFI156',...fields.map(k=>r[k]||'-')].join(':'),period,value_num:v,unit:cfg.unit||'source_reported',dimensions:r,payload:r};}).filter(x=>x.period&&x.value_num!=null);return {rows,meta:{...meta,fetched:rows.length}};}
function secretValue(env,name){const value=name?env[name]:null;if(!value)return value;try{return /%[0-9a-f]{2}/i.test(value)?decodeURIComponent(value):value;}catch{throw new Error('INVALID_KEY_ENCODING');}}

async function collectBojo(env,cfg){
  const key=secretValue(env,'BOJO_API_KEY');if(!key)throw new Error('BOJO_API_KEY_NOT_CONFIGURED');
  const u=new URL(cfg.endpoint_url);for(const [k,v] of Object.entries(cfg.query||{}))if(!u.searchParams.has(k))u.searchParams.set(k,String(v));
  u.searchParams.set('resultType','json');u.searchParams.set('serviceKey',key);const page=Number(cfg.sync_page||u.searchParams.get('pageNo')||1);u.searchParams.set('pageNo',String(page));
  const {text}=await responseText(u.toString());if(text.trim().startsWith('<'))throw new Error('BOJO_XML_RESPONSE:check_key_and_JSON_access');
  const data=JSON.parse(text),response=data.response||data,code=response.header?.resultCode??data.resultCode;
  if(code!=null&&!['00','0','0000'].includes(String(code)))throw new Error('BOJO_API_ERROR:'+String(code));
  const body=response.body||response;let list=pathGet(data,cfg.rows_path);if(list==null)list=body.items?.item||body.items;
  if(list==null)throw new Error('BOJO_RESPONSE_SCHEMA_MISMATCH');list=Array.isArray(list)?list:[list];
  const rows=list.map(r=>{const fields=cfg.series_key_fields||['REALM_CODE','SECT_CODE'];const category=fields.map(k=>r[k]);const period=String(r[cfg.period_path||'BSNSYEAR']||'');const value=num(r[cfg.value_path||'BGAMT']);if(category.some(x=>x==null||x==='')||!period||value==null)throw new Error('BOJO_ROW_SCHEMA_MISMATCH');return{jurisdiction:'KR',metric_code:cfg.metric_code||'bojo.budget.by_sector',series_key:['T_OPD_PRMSCT_SBBGST',...category].join(':'),period,value_num:value,unit:cfg.unit||'source_reported_budget_unit',dimensions:r,payload:r};});
  const total=Number(body.totalCount),size=Number(body.numOfRows||cfg.query?.numOfRows||10);const partial=Number.isFinite(total)&&page*size<total;
  if(partial&&page>=500)throw new Error('BOJO_PAGINATION_LIMIT');return {rows,nextPage:partial?page+1:1,partial};
}
async function collectConfigurable(env,connector,cfg){
  if(!cfg.endpoint_url)throw new Error('CONFIG_REQUIRED:endpoint_url');const u=new URL(cfg.endpoint_url);const sec=secretValue(env,connector.secret_name);if(connector.requires_secret&&!sec)throw new Error(`${connector.secret_name}_NOT_CONFIGURED`);if(sec&&cfg.auth_query_name)u.searchParams.set(cfg.auth_query_name,sec);
  for(const [k,v] of Object.entries(cfg.query||{}))u.searchParams.set(k,String(v));const {text,ct}=await responseText(u.toString(),{headers:cfg.headers||{}});let rows=[];
  if(ct.includes('json')||text.trim().startsWith('{')||text.trim().startsWith('[')){const j=JSON.parse(text);const a=pathGet(j,cfg.rows_path);rows=Array.isArray(a)?a:[a??j];}else rows=csvRows(text);
  return rows.map((r,i)=>{const raw=pathGet(r,cfg.value_path||'value'),v=num(raw),period=String(pathGet(r,cfg.period_path||'period')||pathGet(r,'year')||pathGet(r,'date')||i);return{jurisdiction:cfg.jurisdiction||'KR',metric_code:cfg.metric_code||connector.id,series_key:cfg.series_key||connector.id,period,value_num:v,value_text:v==null?String(raw??''):null,unit:cfg.unit||String(pathGet(r,cfg.unit_path||'unit')||''),dimensions:r,payload:r};}).filter(x=>x.period);
}

export async function enableOfficialConnector(env,projectId,connectorId,config={}){
  const d=OFFICIAL_CONNECTORS[connectorId];if(!d)throw new Error('unknown_connector');const ts=nowIso(),merged={...d.default_config,...config};
  const sourceEnabled=merged.status==='CONFIG_REQUIRED'?0:1;
  await run(env.DB,`INSERT INTO project_case_layers(project_id,layer_code,case_name,description,enabled,status,created_at,updated_at) VALUES(?,?,?,?,1,'configured',?,?) ON CONFLICT(project_id,layer_code) DO UPDATE SET enabled=1,updated_at=excluded.updated_at`,[projectId,d.case_layer,d.case_layer==='A'?'Case A · Public Payment / CBDC':'Case B · Fiscal / Subsidy Payment',d.case_layer==='A'?'CBDC·지급결제 외부검증 계층':'국고금·보조금 지급정지 일반화 계층',ts,ts]);
  const ex=await one(env.DB,`SELECT id FROM data_sources WHERE project_id=? AND connector_id=?`,[projectId,connectorId]);if(ex){await run(env.DB,`UPDATE data_sources SET name=?,kind='official_connector',url=?,case_layer=?,data_role=?,config_json=?,enabled=?,cadence_minutes=?,last_fetched_at=NULL,last_status=NULL,next_fetch_at=? WHERE id=?`,[d.name,d.url,d.case_layer,d.data_role,JSON.stringify(merged),sourceEnabled,d.cadence_minutes,sourceEnabled?ts:null,ex.id]);return{id:ex.id,updated:true,config_status:merged.status||'READY'};}
  const id=uid('source');await run(env.DB,`INSERT INTO data_sources(id,project_id,name,kind,url,method,headers_json,mapping_json,enabled,cadence_minutes,created_at,connector_id,case_layer,data_role,config_json,last_record_count,next_fetch_at,coverage_json) VALUES(?,?,?,?,?,'GET','{}','{}',?, ?,?,?,?,?,?,0,?,'{}')`,[id,projectId,d.name,'official_connector',d.url,sourceEnabled,d.cadence_minutes,ts,d.id,d.case_layer,d.data_role,JSON.stringify(merged),sourceEnabled?ts:null]);await audit(env,projectId,'user','official_source.enabled','data_source',id,{connector_id:d.id,case_layer:d.case_layer,data_role:d.data_role,config_status:merged.status||'READY'});return{id,created:true,config_status:merged.status||'READY'};
}

async function upsertObservations(env,projectId,source,rows){
  if(!rows.length)return 0;const ts=nowIso();
  // D1 N+1 제거: incoming row마다 SELECT 1회 + UPSERT 1회를 수행하던 구조를 source 단위 1회 prefetch + 변경행 batch write로 변경.
  const existing=await all(env.DB,`SELECT series_key,period,jurisdiction,metric_code,value_num,value_text,unit,payload_json FROM official_observations WHERE source_id=?`,[source.id]);
  const keyOf=x=>`${x.series_key}|${x.period}|${String(x.jurisdiction??'')}|${x.metric_code}`;
  const prior=new Map(existing.map(x=>[keyOf(x),x])),stmts=[];
  for(const x0 of rows){const x={...x0,jurisdiction:String(x0.jurisdiction??'')},payload=JSON.stringify(x.payload||{}),vtext=x.value_text??null,p=prior.get(keyOf(x));
    if(p&&Number(p.value_num)===Number(x.value_num)&&String(p.value_text??'')===String(vtext??'')&&String(p.unit??'')===String(x.unit??'')&&String(p.payload_json??'')===payload)continue;
    stmts.push(env.DB.prepare(`INSERT INTO official_observations(id,project_id,source_id,connector_id,case_layer,jurisdiction,metric_code,series_key,period,value_num,value_text,unit,dimensions_json,payload_json,observed_at,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,series_key,period,jurisdiction,metric_code) DO UPDATE SET value_num=excluded.value_num,value_text=excluded.value_text,unit=excluded.unit,dimensions_json=excluded.dimensions_json,payload_json=excluded.payload_json,observed_at=excluded.observed_at,fetched_at=excluded.fetched_at`).bind(uid('offobs'),projectId,source.id,source.connector_id,source.case_layer,x.jurisdiction,x.metric_code,x.series_key,x.period,x.value_num,vtext,x.unit||'',JSON.stringify(x.dimensions||{}),payload,x.period,ts));
  }
  for(let i=0;i<stmts.length;i+=80)await env.DB.batch(stmts.slice(i,i+80));
  return stmts.length;
}

export async function collectOfficialSource(env,projectId,source){
  const d=OFFICIAL_CONNECTORS[source.connector_id];if(!d)throw new Error(`unknown_connector:${source.connector_id}`);const cfg=safeJson(source.config_json,d.default_config),runId=uid('sync'),started=nowIso();await run(env.DB,`INSERT INTO official_source_sync_runs(id,project_id,source_id,connector_id,case_layer,started_at,status) VALUES(?,?,?,?,?,?,'running')`,[runId,projectId,source.id,d.id,d.case_layer,started]);
  try{let rows=[],pack=null;if(d.id==='bojo_openapi'&&cfg.endpoint_url?.includes('/T_OPD_PRMSCT_SBBGST')){pack=await collectBojo(env,cfg);rows=pack.rows;}else if(d.id==='bis_cpmi')rows=await collectBis(cfg);else if(d.id==='ecb_supervisory')rows=await collectEcb(cfg);else if(d.id==='bok_ecos'){pack=await collectEcos(env,cfg);rows=pack.rows;}else if(d.id==='openfiscal'){pack=await collectOpenFiscal(env,cfg);rows=pack.rows;}else rows=await collectConfigurable(env,d,cfg);if(!rows.length)throw new Error('NO_DATA_ROWS:check_series_key_and_period');const changed=await upsertObservations(env,projectId,source,rows);const mapping=(d.id==='bis_cpmi'||d.id==='ecb_supervisory')?await refreshOfficialMappings(env,projectId,d.id):{updated:0,mappings:[]};await run(env.DB,`UPDATE official_source_sync_runs SET completed_at=?,status='ok',fetched_rows=?,changed_rows=?,detail_json=? WHERE id=?`,[nowIso(),rows.length,changed,JSON.stringify({connector_id:d.id,connector_meta:pack?.meta||null,mapping_updated:mapping.updated,mappings:mapping.mappings.map(x=>({key:x.mapping_key,status:x.status,period:x.period,value:x.value}))}),runId]);{const ts=nowIso(),periods=rows.map(x=>String(x.period||'')).filter(Boolean).sort(),coverage={rows:rows.length,metrics:new Set(rows.map(x=>x.metric_code)).size,first_period:periods[0]||null,last_period:periods.at(-1)||null};await run(env.DB,`UPDATE data_sources SET last_fetched_at=?,last_status='ok',last_record_count=?,coverage_json=?,next_fetch_at=strftime('%Y-%m-%dT%H:%M:%fZ',datetime(?,'+' || cadence_minutes || ' minutes')) WHERE id=?`,[ts,rows.length,JSON.stringify(coverage),ts,source.id]);}if(pack?.nextPage)await run(env.DB,`UPDATE data_sources SET config_json=?,last_fetched_at=?,last_status=?,next_fetch_at=? WHERE id=?`,[JSON.stringify({...cfg,sync_page:pack.nextPage}),pack.partial?null:nowIso(),pack.partial?'partial:resume_next_page':'ok',pack.partial?nowIso():null,source.id]);return{inserted:changed,fetched:rows.length,changed,partial:!!pack?.partial,connector_id:d.id,case_layer:d.case_layer,mapping,meta:pack?.meta||null};}
  catch(e){await run(env.DB,`UPDATE official_source_sync_runs SET completed_at=?,status='error',error_text=? WHERE id=?`,[nowIso(),String(e).slice(0,500),runId]);await run(env.DB,`UPDATE data_sources SET last_fetched_at=?,last_status=?,next_fetch_at=strftime('%Y-%m-%dT%H:%M:%fZ',datetime(?,'+' || cadence_minutes || ' minutes')) WHERE id=?`,[nowIso(),`error:${String(e).slice(0,120)}`,nowIso(),source.id]);throw e;}
}

export async function testOfficialConnector(env,connectorId,config={}){
  const d=OFFICIAL_CONNECTORS[connectorId];if(!d)throw new Error('unknown_connector');const cfg={...d.default_config,...config};let pack,rows;
  if(connectorId==='bok_ecos'){pack=await collectEcos(env,cfg);rows=pack.rows;}
  else if(connectorId==='openfiscal'){pack=await collectOpenFiscal(env,cfg);rows=pack.rows;}
  else throw new Error('connector_test_not_supported');
  const periods=rows.map(x=>String(x.period||'')).filter(Boolean).sort();return {ok:true,connector_id:connectorId,fetched:rows.length,first_period:periods[0]||null,last_period:periods.at(-1)||null,metrics:[...new Set(rows.map(x=>x.metric_code))],meta:pack?.meta||null};
}

export async function officialSourceStatus(env,projectId){
  // Three dashboard reads are independent; batch them to one D1 round-trip.
  const b=await env.DB.batch([
    env.DB.prepare(`SELECT * FROM project_case_layers WHERE project_id=? ORDER BY layer_code`).bind(projectId),
    env.DB.prepare(`SELECT id,name,connector_id,case_layer,data_role,enabled,last_fetched_at,last_status,last_record_count,config_json,coverage_json,next_fetch_at FROM data_sources WHERE project_id=? AND connector_id IS NOT NULL ORDER BY case_layer,created_at`).bind(projectId)
  ]);
  let layers=b[0]?.results||[],sources=b[1]?.results||[];
  const mappings=await getOfficialMappings(env,projectId);
  return{layers,mappings,sources:sources.map(s=>{const config=safeJson(s.config_json,{}),coverage={rows:Number(s.last_record_count||0),metrics:0,...safeJson(s.coverage_json,{})},d=OFFICIAL_CONNECTORS[s.connector_id];const configMissing=['openfiscal','bojo_openapi'].includes(s.connector_id)&&!config.endpoint_url,secretConfigured=!d?.requires_secret||!!secretValue(env,d?.secret_name);return {...s,config,readiness:configMissing?'CONFIG_REQUIRED':!s.enabled?'DISABLED':!secretConfigured?'SECRET_MISSING':s.last_status||'QUEUED_OR_NOT_FETCHED',requires_secret:!!d?.requires_secret,secret_name:d?.secret_name||null,secret_configured:secretConfigured,coverage};})};
}

// Pure/internal hooks for regression tests; not used by API routing.
export const __test={upsertObservations,parseOpenFiscalXml,collectOpenFiscal,collectEcos};
