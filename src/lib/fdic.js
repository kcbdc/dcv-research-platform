import { all, one, run, audit } from './db.js';
import { nowIso, uid, safeJson } from './util.js';

const BASE='https://api.fdic.gov/banks';
const PAGE_LIMIT=10000;

export function normalizeBankName(s=''){
  return String(s).toLowerCase()
    .replace(/[_/.-]+/g,' ')
    .replace(/\b(stress|mm|wm|bk|fsb|na|n a|national association|national bank|bank|bancorp|financial|savings|association|corp|corporation|company|co|plc|ag|sa)\b/g,' ')
    .replace(/[^a-z0-9 ]+/g,' ')
    .replace(/\s+/g,' ').trim();
}

function tokens(s){ return new Set(normalizeBankName(s).split(' ').filter(x=>x.length>1)); }
function scoreNormalized(na,A,nb,B){
  if(!A.size||!B.size)return 0;
  let inter=0;for(const x of A)if(B.has(x))inter++;
  const union=A.size+B.size-inter,jac=inter/union;
  const contain=(na.includes(nb)||nb.includes(na))?1:0;
  return Math.min(1,0.78*jac+0.22*contain);
}
export function bankNameScore(a,b){
  const na=normalizeBankName(a),nb=normalizeBankName(b);
  return scoreNormalized(na,tokensOf(na),nb,tokensOf(nb));
}
function tokensOf(norm){return new Set(norm.split(' ').filter(x=>x.length>1));}
// Normalise every candidate once and index by token, so each episode only scores banks sharing a token
// (a score >= 0.48 is impossible without one). Replaces episodes x banks full cross-scoring (~300k regex-heavy calls).
function buildBankIndex(rows){
  const entries=[],byToken=new Map();
  for(const r of rows){
    const name=pick(r,['NAME','NAMEFULL','name'])||'',norm=normalizeBankName(name),toks=tokensOf(norm);
    if(!toks.size)continue;
    const idx=entries.push({r,norm,toks})-1;
    for(const t of toks){let l=byToken.get(t);if(!l)byToken.set(t,l=[]);l.push(idx);}
  }
  return {entries,byToken};
}
function matchBanks(index,episodeName,minScore=0.48,top=5){
  const na=normalizeBankName(episodeName),A=tokensOf(na);if(!A.size)return [];
  const seen=new Set(),scored=[];
  for(const t of A)for(const i of index.byToken.get(t)||[]){
    if(seen.has(i))continue;seen.add(i);
    const e=index.entries[i],score=scoreNormalized(na,A,e.norm,e.toks);
    if(score>=minScore)scored.push({r:e.r,score,i});
  }
  return scored.sort((x,y)=>y.score-x.score||x.i-y.i).slice(0,top);
}

export function computeHhi(bankDeposits){
  const vals=Object.values(bankDeposits||{}).map(Number).filter(x=>Number.isFinite(x)&&x>0);
  const total=vals.reduce((a,b)=>a+b,0); if(!total)return {hhi:null,total:0,bank_count:0};
  return {hhi:vals.reduce((a,v)=>a+(v/total)**2,0),total,bank_count:vals.length};
}

export function summarizeFinancialRows(rows=[]){
  const xs=rows.map(unwrap).map(r=>({
    repdte:String(pick(r,['REPDTE','repdte','REPORT_DATE','date'])||''),
    deposits:toNum(pick(r,['DEPDOM','DEP','DEPOSITS','depdom','dep'])),
    asset:toNum(pick(r,['ASSET','asset'])),
    raw:r
  })).filter(x=>x.repdte).sort((a,b)=>a.repdte.localeCompare(b.repdte));
  const ds=xs.filter(x=>Number.isFinite(x.deposits)&&x.deposits>0);
  if(ds.length<2)return {quarters:xs.length,deposit_points:ds.length,deposit_change:null,deposit_outflow_proxy:null,peak_drawdown:null,peak_date:null,first:null,last:null};
  const first=ds[0],last=ds[ds.length-1];
  let runningPeak=ds[0].deposits,peakDrawdown=0,peakDate=ds[0].repdte;
  for(const x of ds){
    if(x.deposits>runningPeak)runningPeak=x.deposits;
    const dd=runningPeak>0?(runningPeak-x.deposits)/runningPeak:0;
    if(dd>peakDrawdown){peakDrawdown=dd;peakDate=x.repdte;}
  }
  const depositChange=first.deposits>0?last.deposits/first.deposits-1:null;
  return {quarters:xs.length,deposit_points:ds.length,deposit_change:depositChange,deposit_outflow_proxy:Math.max(0,-depositChange),peak_drawdown:peakDrawdown,peak_date:peakDate,first:{repdte:first.repdte,deposits:first.deposits},last:{repdte:last.repdte,deposits:last.deposits}};
}

function toNum(v){ if(v===null||v===undefined||v==='')return null; const n=Number(v); return Number.isFinite(n)?n:null; }
function pick(o,keys){ for(const k of keys) if(o?.[k]!==undefined&&o?.[k]!==null&&o?.[k]!=='')return o[k]; return null; }
function unwrap(r){ return r?.data && typeof r.data==='object' ? r.data : r; }
function qDate(y,m,d){ return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function rowKey(r){
  const x=unwrap(r); return [pick(x,['YEAR','year']),pick(x,['CERT','cert']),pick(x,['UNINUMBR','uninumber']),pick(x,['BRNUM','brnum']),pick(x,['STALPBR','state'])].join('|');
}

function headers(env){
  const h={accept:'application/json'};
  if(env.FDIC_API_KEY) h['X-Api-Key']=env.FDIC_API_KEY;
  return h;
}

const RETRYABLE=new Set([408,425,429,500,502,503,504]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Transient upstream failures (503 etc.) are retried with backoff; the final error is labelled so the UI can explain it.
async function fdicRequest(env,endpoint,url,{attempts=3,timeoutMs=25000}={}){
  let last=null;
  for(let i=0;i<attempts;i++){
    try{
      const resp=await fetch(url,{headers:headers(env),signal:AbortSignal.timeout(timeoutMs)});
      if(resp.ok){
        try{return await resp.json();}catch{throw new Error(`FDIC_NON_JSON:${endpoint}`);}
      }
      const retryAfter=Number(resp.headers?.get?.('retry-after'));
      last=new Error(`FDIC_HTTP_${resp.status}:${endpoint}`);last.status=resp.status;
      if(!RETRYABLE.has(resp.status))throw last;
      if(i<attempts-1)await sleep(Math.min(4000,Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:500*2**i));
    }catch(e){
      if(String(e?.message||'').startsWith('FDIC_'))throw e;
      const name=String(e?.name||'');
      last=new Error(name==='TimeoutError'||name==='AbortError'?`FDIC_TIMEOUT:${endpoint}`:`FDIC_NETWORK:${endpoint}:${String(e?.message||e).slice(0,100)}`);
      if(i<attempts-1)await sleep(500*2**i);
    }
  }
  throw last;
}

async function fdicFetch(env, endpoint, params={}, {maxPages=20}={}){
  let offset=0, out=[], total=null, pages=0;
  do{
    const u=new URL(`${BASE}/${endpoint}`);
    const p={...params,limit:Math.min(PAGE_LIMIT,Number(params.limit||PAGE_LIMIT)),offset,format:'json'};
    for(const [k,v] of Object.entries(p)) if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,String(v));
    const j=await fdicRequest(env,endpoint,u.toString());
    const rows=Array.isArray(j?.data)?j.data:[]; out.push(...rows);
    total=Number(j?.meta?.total ?? j?.metadata?.total ?? j?.meta?.total_count ?? rows.length);
    pages++; offset+=rows.length;
    if(!rows.length||rows.length<Number(p.limit)||out.length>=total)break;
  }while(pages<maxPages);
  return {rows:out,total:Number.isFinite(total)?total:out.length,pages,truncated:Number.isFinite(total)&&out.length<total};
}

const FDIC_ERROR_HINTS=[
  [/FDIC_HTTP_503|FDIC_HTTP_502|FDIC_HTTP_504|FDIC_HTTP_500/,'fdic_upstream_unavailable','FDIC API(api.fdic.gov)가 일시적으로 응답하지 않습니다(자동 재시도 후에도 실패). 잠시 후 다시 시도하세요. 이미 확정된 매칭은 유지됩니다.'],
  [/FDIC_HTTP_429/,'fdic_rate_limited','FDIC API 호출 한도를 초과했습니다. 잠시 후 다시 시도하거나 FDIC_API_KEY 시크릿을 등록하세요.'],
  [/FDIC_HTTP_40[13]/,'fdic_forbidden','FDIC API 접근이 거부되었습니다. FDIC_API_KEY 설정을 확인하세요.'],
  [/FDIC_TIMEOUT/,'fdic_timeout','FDIC API 응답이 지연되었습니다. 잠시 후 다시 시도하세요.'],
  [/FDIC_NETWORK/,'fdic_network_error','FDIC API에 연결하지 못했습니다. 잠시 후 다시 시도하세요.'],
  [/FDIC_NON_JSON/,'fdic_non_json','FDIC API가 JSON이 아닌 응답을 반환했습니다. 점검 중일 수 있습니다.']
];
export function explainFdicError(e){
  const msg=String(e?.message||e||'unknown_error').replace(/^Error:\s*/,'');
  const hit=FDIC_ERROR_HINTS.find(([re])=>re.test(msg));
  return {error:msg,code:hit?hit[1]:'fdic_unexpected_error',hint:hit?hit[2]:'예상하지 못한 오류입니다. wrangler tail 로그를 확인하세요.',retryable:!!hit&&hit[1]!=='fdic_forbidden'};
}

export async function resolveFdicLinks(env,projectId,{autoConfirm=true,maxEpisodes=81}={}){
  // One Failure endpoint fetch resolves many failed US episodes without 81 network calls.
  const eps=await all(env.DB,`SELECT e.* FROM empirical_episodes e LEFT JOIN fdic_episode_links l ON l.episode_id=e.id AND l.project_id=e.project_id WHERE e.project_id=? AND (l.id IS NULL OR l.match_status!='confirmed') ORDER BY e.year,e.episode_name LIMIT ?`,[projectId,maxEpisodes]);
  if(!eps.length)return {episodes:0,confirmed:0,pending:0,candidates:0};
  const failureResp=await fdicFetch(env,'failures',{limit:10000,fields:'CERT,NAME,FAILDATE,CITYST'},{maxPages:2});
  const failures=failureResp.rows.map(unwrap),bankIndex=buildBankIndex(failures);
  let confirmed=0,pending=0,candidates=0; const linkWrites=[];
  for(const e of eps){
    const scored=matchBanks(bankIndex,e.episode_name);
    if(!scored.length)continue;
    candidates+=scored.length;
    const best=scored[0], second=scored[1];
    const cert=Number(pick(best.r,['CERT','cert'])); if(!Number.isFinite(cert))continue;
    const strong=best.score>=0.90 && (!second || best.score-second.score>=0.12);
    const status=autoConfirm&&strong?'confirmed':'pending';
    const now=nowIso(),name=String(pick(best.r,['NAME','NAMEFULL','name'])||'');
    linkWrites.push(env.DB.prepare(`INSERT INTO fdic_episode_links(id,project_id,episode_id,cert,institution_name,match_status,match_method,match_score,candidate_json,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,episode_id) DO UPDATE SET cert=excluded.cert,institution_name=excluded.institution_name,match_status=CASE WHEN fdic_episode_links.match_status='confirmed' THEN 'confirmed' ELSE excluded.match_status END,match_method=excluded.match_method,match_score=excluded.match_score,candidate_json=excluded.candidate_json,confirmed_at=CASE WHEN fdic_episode_links.match_status='confirmed' THEN fdic_episode_links.confirmed_at ELSE excluded.confirmed_at END,updated_at=excluded.updated_at`).bind(
      uid('fdiclink'),projectId,e.id,cert,name,status,strong?'failure_exact':'failure_fuzzy',best.score,JSON.stringify(scored.map(x=>({cert:pick(x.r,['CERT','cert']),name:pick(x.r,['NAME','NAMEFULL','name']),score:Number(x.score.toFixed(4))}))),status==='confirmed'?now:null,now,now));
    status==='confirmed'?confirmed++:pending++;
  }
  for(let i=0;i<linkWrites.length;i+=50)await env.DB.batch(linkWrites.slice(i,i+50));
  await audit(env,projectId,'agent','fdic.links.resolved','fdic_link',null,{episodes:eps.length,confirmed,pending,candidates,failure_total:failureResp.total});
  return {episodes:eps.length,confirmed,pending,candidates,failure_total:failureResp.total};
}

export async function confirmFdicLink(env,projectId,{episode_id,episode_name,cert,institution_name='',method='manual'}={}){
  let ep=episode_id?await one(env.DB,`SELECT * FROM empirical_episodes WHERE id=? AND project_id=?`,[episode_id,projectId]):null;
  if(!ep&&episode_name)ep=await one(env.DB,`SELECT * FROM empirical_episodes WHERE project_id=? AND episode_name=? ORDER BY year DESC LIMIT 1`,[projectId,episode_name]);
  if(!ep)throw new Error('episode_not_found'); const c=Number(cert); if(!Number.isFinite(c)||c<=0)throw new Error('invalid_fdic_cert');
  const now=nowIso();
  await run(env.DB,`INSERT INTO fdic_episode_links(id,project_id,episode_id,cert,institution_name,match_status,match_method,match_score,candidate_json,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,?,'confirmed',?,1,'{}',?,?,?) ON CONFLICT(project_id,episode_id) DO UPDATE SET cert=excluded.cert,institution_name=excluded.institution_name,match_status='confirmed',match_method=excluded.match_method,match_score=1,confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at`,[uid('fdiclink'),projectId,ep.id,c,institution_name,method,now,now,now]);
  await audit(env,projectId,'user','fdic.link.confirmed','empirical_episode',ep.id,{cert:c,institution_name,method});
  return {episode_id:ep.id,episode_name:ep.episode_name,cert:c,status:'confirmed'};
}


async function writeFdicRows(db,table,columns,rows,conflict){
 let changed=0;
 for(let i=0;i<rows.length;i+=500){
  const r=await run(db,`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map((_,j)=>`json_extract(value,'$[${j}]')`).join(',')} FROM json_each(?) WHERE 1 ${conflict}`,[JSON.stringify(rows.slice(i,i+500))]);
  changed+=Number(r.meta?.changes||0);
 }
 return changed;
}

async function collectFinancialForLink(env,projectId,link){
  const y=Number(link.year); if(!Number.isFinite(y)||y<1992)return {inserted:0,skipped:'financials_before_1992'};
  const filters=`CERT:${link.cert} AND REPDTE:[${qDate(y-1,1,1)} TO ${qDate(y,12,31)}]`;
  const r=await fdicFetch(env,'financials',{filters,sort_by:'REPDTE',sort_order:'ASC',limit:1000},{maxPages:4});
  let inserted=0; const now=nowIso(),writes=[];
  for(const row0 of r.rows){ const row=unwrap(row0),rep=String(pick(row,['REPDTE','repdte'])||''); if(!rep)continue;
    writes.push([uid('fdicfin'),projectId,link.episode_id,link.cert,rep,toNum(pick(row,['ASSET','asset'])),toNum(pick(row,['DEP','DEPOSITS','dep'])),toNum(pick(row,['DEPDOM','depdom'])),toNum(pick(row,['DEPUNINS','UNINSDEP','depunins'])),toNum(pick(row,['EQ','EQV','EQTOT','equity'])),JSON.stringify(row),now]);
  }
  inserted=await writeFdicRows(env.DB,'fdic_financial_observations','id,project_id,episode_id,cert,repdte,asset,deposits_total,deposits_domestic,uninsured_deposits,equity,payload_json,fetched_at'.split(','),writes,'ON CONFLICT(project_id,cert,repdte) DO UPDATE SET episode_id=excluded.episode_id,asset=excluded.asset,deposits_total=excluded.deposits_total,deposits_domestic=excluded.deposits_domestic,uninsured_deposits=excluded.uninsured_deposits,equity=excluded.equity,payload_json=excluded.payload_json,fetched_at=excluded.fetched_at WHERE fdic_financial_observations.payload_json<>excluded.payload_json');
  const summary=summarizeFinancialRows(r.rows);
  return {inserted,rows:r.rows.length,total:r.total,truncated:r.truncated,summary};
}

async function collectSodForLink(env,projectId,link,{marketHhi=true}={}){
  const y=Number(link.year); if(!Number.isFinite(y)||y<1994)return {inserted:0,skipped:'sod_before_1994'};
  const target=await fdicFetch(env,'sod',{filters:`CERT:${link.cert} AND YEAR:${y}`,limit:10000},{maxPages:4});
  const now=nowIso(); let inserted=0;
  const targetRows=target.rows.map(unwrap);
  const stateTotals={},writes=[];
  for(const row of targetRows){
    const dep=toNum(pick(row,['DEPSUMBR','DEPOSITS','dep'])); const state=String(pick(row,['STALPBR','STALP','state'])||'').toUpperCase(); if(state&&Number.isFinite(dep))stateTotals[state]=(stateTotals[state]||0)+dep;
    const key=rowKey(row)||`${y}|${link.cert}|${uid('row')}`;
    writes.push([uid('fdicsod'),projectId,link.episode_id,link.cert,y,String(pick(row,['BRNUM','brnum'])||''),String(pick(row,['UNINUMBR','uninumber'])||''),state,String(pick(row,['CNTYNAMB','COUNTY','county'])||''),String(pick(row,['CBSA','MSA_NO','cbsa'])||''),dep,JSON.stringify(row),now,key]);
  }
  inserted=await writeFdicRows(env.DB,'fdic_sod_observations','id,project_id,episode_id,cert,year,branch_num,uninumber,state,county,cbsa,branch_deposits,payload_json,fetched_at,row_key'.split(','),writes,'ON CONFLICT(project_id,row_key) DO UPDATE SET episode_id=excluded.episode_id,branch_deposits=excluded.branch_deposits,payload_json=excluded.payload_json,fetched_at=excluded.fetched_at WHERE fdic_sod_observations.payload_json<>excluded.payload_json');
  const primaryState=Object.entries(stateTotals).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  let metric=null;
  if(marketHhi&&primaryState){
    const market=await fdicFetch(env,'sod',{filters:`STALPBR:${primaryState} AND YEAR:${y}`,limit:10000},{maxPages:12});
    const byBank={};
    for(const row0 of market.rows){ const row=unwrap(row0),cert=String(pick(row,['CERT','cert'])||''),dep=toNum(pick(row,['DEPSUMBR','DEPOSITS','dep'])); if(cert&&Number.isFinite(dep)&&dep>0)byBank[cert]=(byBank[cert]||0)+dep; }
    const h=computeHhi(byBank),targetDep=Number(byBank[String(link.cert)]||0),share=h.total?targetDep/h.total:null;
    const quality={source:'FDIC Summary of Deposits',scope:'state',state:primaryState,market_rows:market.rows.length,truncated:market.truncated,as_reported:true,interpretation:'verification_covariate_not_automatic_replacement_for_thesis_C'};
    const existing=await one(env.DB,`SELECT id FROM fdic_market_metrics WHERE project_id=? AND episode_id=? AND year=? AND market_type='state' AND market_key=?`,[projectId,link.episode_id,y,primaryState]);
    const id=existing?.id||uid('fdicmetric');
    await run(env.DB,`INSERT INTO fdic_market_metrics(id,project_id,episode_id,cert,year,market_type,market_key,hhi,bank_count,total_deposits,target_bank_share,methodology_version,quality_json,created_at,updated_at) VALUES(?,?,?,?,?,'state',?,?,?,?,?,'FDIC-SOD-STATE-HHI-v1',?,?,?) ON CONFLICT(project_id,episode_id,year,market_type,market_key) DO UPDATE SET hhi=excluded.hhi,bank_count=excluded.bank_count,total_deposits=excluded.total_deposits,target_bank_share=excluded.target_bank_share,quality_json=excluded.quality_json,updated_at=excluded.updated_at`,[id,projectId,link.episode_id,link.cert,y,primaryState,h.hhi,h.bank_count,h.total,share,JSON.stringify(quality),now,now]);
    metric={state:primaryState,hhi:h.hhi,bank_count:h.bank_count,total_deposits:h.total,target_bank_share:share,truncated:market.truncated};
  }
  return {inserted,target_rows:targetRows.length,total:target.total,primary_state:primaryState,metric};
}

export async function collectFdicSource(env,projectId,source){
  const links=await all(env.DB,`SELECT l.*,e.year,e.episode_name FROM fdic_episode_links l JOIN empirical_episodes e ON e.id=l.episode_id WHERE l.project_id=? AND l.match_status='confirmed' ORDER BY e.year,e.episode_name`,[projectId]);
  if(!links.length)return {inserted:0,linked:0,warning:'no_confirmed_fdic_episode_links'};
  let inserted=0,details=[],errors=[];
  const offset=Math.max(0,Math.min(links.length-1,Number(safeJson(source.mapping_json,{}).fdic_cursor||0)));
  const selected=links.slice(offset,offset+(env.EXTERNAL_RUNTIME==='github-actions'?1:2));
  for(const link of selected){
    try{
      const r=source.kind==='fdic_sod'?await collectSodForLink(env,projectId,link):await collectFinancialForLink(env,projectId,link);
      inserted+=Number(r.inserted||0); details.push({episode:link.episode_name,cert:link.cert,...r});
    }catch(e){errors.push({episode:link.episode_name,cert:link.cert,error:String(e.message||e)});}
  }
  const next=offset+selected.length,partial=!errors.length&&next<links.length,nextCursor=errors.length?offset:partial?next:0;
  await run(env.DB,`UPDATE data_sources SET mapping_json=json_set(COALESCE(mapping_json,'{}'),'$.fdic_cursor',?),last_fetched_at=? WHERE id=?`,[nextCursor,partial?null:nowIso(),source.id]);
  await audit(env,projectId,'agent',`fdic.collect.${source.kind}`,'data_source',source.id,{linked:links.length,inserted,errors:errors.length});
  let reverification=null;
  try{ reverification=await buildFdicReverificationRankings(env,projectId); }
  catch(e){ errors.push({scope:'reverification_ranking',error:String(e.message||e)}); }
  return {inserted,linked:links.length,processed:selected.length,partial,next_cursor:nextCursor,details,errors,reverification};
}

export async function enableFdicConnectors(env,projectId){
  const defs=[
    {kind:'fdic_financials',name:'FDIC BankFind — Financials',url:`${BASE}/financials`,cadence:10080},
    {kind:'fdic_sod',name:'FDIC BankFind — Summary of Deposits',url:`${BASE}/sod`,cadence:43200}
  ];
  const created=[];
  for(const d of defs){
    const exists=await one(env.DB,`SELECT id FROM data_sources WHERE project_id=? AND kind=? LIMIT 1`,[projectId,d.kind]);
    if(exists)continue;
    const id=uid('source');
    await run(env.DB,`INSERT INTO data_sources(id,project_id,name,kind,url,method,headers_json,mapping_json,enabled,cadence_minutes,created_at) VALUES(?,?,?,?,?,'GET','{}','{}',1,?,?)`,[id,projectId,d.name,d.kind,d.url,d.cadence,nowIso()]);
    created.push({id,kind:d.kind});
  }
  await audit(env,projectId,'user','fdic.connectors.enabled','data_source',null,{created});
  return {created};
}


function empiricalPercentile(values,x){
  const xs=values.filter(Number.isFinite).sort((a,b)=>a-b); if(!xs.length||!Number.isFinite(x))return null;
  const le=xs.filter(v=>v<=x).length; return le/xs.length;
}

export async function buildFdicReverificationRankings(env,projectId){
  const rows=await all(env.DB,`SELECT e.id episode_id,e.episode_name,e.year,e.concentration,e.peak_outflow,e.provenance_type,l.cert,l.institution_name,
    (SELECT m.hhi FROM fdic_market_metrics m WHERE m.project_id=e.project_id AND m.episode_id=e.id ORDER BY m.updated_at DESC LIMIT 1) fdic_hhi
    FROM empirical_episodes e JOIN fdic_episode_links l ON l.episode_id=e.id AND l.project_id=e.project_id
    WHERE e.project_id=? AND l.match_status='confirmed' ORDER BY e.year,e.episode_name`,[projectId]);
  const provisional=[];
  for(const r of rows){
    const fin=await all(env.DB,`SELECT repdte,deposits_domestic DEPDOM,deposits_total DEP FROM fdic_financial_observations WHERE project_id=? AND episode_id=? ORDER BY repdte`,[projectId,r.episode_id]);
    const fs=summarizeFinancialRows(fin);
    const C=toNum(r.concentration),hhi=toNum(r.fdic_hhi),po=toNum(r.peak_outflow),dd=toNum(fs.peak_drawdown);
    provisional.push({...r,
      concentration_gap:Number.isFinite(C)&&Number.isFinite(hhi)?Math.abs(C-hhi):null,
      deposit_gap:Number.isFinite(po)&&Number.isFinite(dd)?Math.abs(po-dd):null,
      fdic_peak_drawdown:Number.isFinite(dd)?dd:null,
      deposit_change:fs.deposit_change,
      financial_points:fs.deposit_points,
      peak_drawdown_date:fs.peak_date,
      comparable_dimensions:(Number.isFinite(C)&&Number.isFinite(hhi)?1:0)+(Number.isFinite(po)&&Number.isFinite(dd)?1:0)
    });
  }
  const cg=provisional.map(x=>x.concentration_gap).filter(Number.isFinite), dg=provisional.map(x=>x.deposit_gap).filter(Number.isFinite);
  for(const x of provisional){
    x.concentration_percentile=empiricalPercentile(cg,x.concentration_gap);
    x.deposit_percentile=empiricalPercentile(dg,x.deposit_gap);
    const ps=[x.concentration_percentile,x.deposit_percentile].filter(Number.isFinite);
    x.discrepancy_score=ps.length?ps.reduce((a,b)=>a+b,0)/ps.length:null;
  }
  provisional.sort((a,b)=>(b.discrepancy_score??-1)-(a.discrepancy_score??-1) || (a.provenance_type==='verified'?1:0)-(b.provenance_type==='verified'?1:0) || a.episode_name.localeCompare(b.episode_name));
  const now=nowIso(); let rank=0;
  const priorIds=new Map((await all(env.DB,`SELECT episode_id,id FROM fdic_reverification_rankings WHERE project_id=?`,[projectId])).map(x=>[x.episode_id,x.id])),rankingWrites=[];
  for(const x of provisional){
    if(Number.isFinite(x.discrepancy_score))rank++;
    const score=x.discrepancy_score;
    const priority=!Number.isFinite(score)?'INSUFFICIENT':score>=0.80?'CRITICAL':score>=0.67?'HIGH':score>=0.33?'MEDIUM':'LOW';
    const reasons=[];
    if(Number.isFinite(x.concentration_gap))reasons.push(`concentration Δ=${x.concentration_gap.toFixed(4)} (FDIC state-HHI vs panel C; diagnostic only)`);
    if(Number.isFinite(x.deposit_gap))reasons.push(`deposit dynamics Δ=${x.deposit_gap.toFixed(4)} (FDIC peak drawdown vs panel peak_outflow; diagnostic proxy)`);
    if(x.provenance_type!=='verified')reasons.push('reconstructed episode: primary-source reverification has higher evidentiary value');
    if(x.financial_points!=null&&x.financial_points<4)reasons.push('limited quarterly Financials coverage');
    const existing={id:priorIds.get(x.episode_id)};
    rankingWrites.push(env.DB.prepare(`INSERT INTO fdic_reverification_rankings(id,project_id,episode_id,cert,rank_num,priority_level,discrepancy_score,original_concentration,fdic_hhi,concentration_gap,concentration_percentile,original_peak_outflow,fdic_peak_drawdown,deposit_gap,deposit_percentile,financial_points,peak_drawdown_date,provenance_type,methodology_version,reason_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'FDIC-REVERIFY-v1',?,?,?)
      ON CONFLICT(project_id,episode_id) DO UPDATE SET cert=excluded.cert,rank_num=excluded.rank_num,priority_level=excluded.priority_level,discrepancy_score=excluded.discrepancy_score,original_concentration=excluded.original_concentration,fdic_hhi=excluded.fdic_hhi,concentration_gap=excluded.concentration_gap,concentration_percentile=excluded.concentration_percentile,original_peak_outflow=excluded.original_peak_outflow,fdic_peak_drawdown=excluded.fdic_peak_drawdown,deposit_gap=excluded.deposit_gap,deposit_percentile=excluded.deposit_percentile,financial_points=excluded.financial_points,peak_drawdown_date=excluded.peak_drawdown_date,provenance_type=excluded.provenance_type,reason_json=excluded.reason_json,updated_at=excluded.updated_at`).bind(
      existing?.id||uid('fdicrank'),projectId,x.episode_id,x.cert,Number.isFinite(score)?rank:null,priority,score,x.concentration,x.fdic_hhi,x.concentration_gap,x.concentration_percentile,x.peak_outflow,x.fdic_peak_drawdown,x.deposit_gap,x.deposit_percentile,x.financial_points,x.peak_drawdown_date,x.provenance_type,JSON.stringify({reasons,comparability:{concentration:'state-market HHI is a validation covariate, not an automatic replacement for thesis C',deposit:'maximum quarterly peak-to-trough drawdown over episode year-1 through episode year is a diagnostic proxy, not the same measurement window as peak_outflow'}}),now,now));
  }
  for(let i=0;i<rankingWrites.length;i+=50)await env.DB.batch(rankingWrites.slice(i,i+50));
  await audit(env,projectId,'agent','fdic.reverification.ranked','empirical_episode',null,{episodes:provisional.length,ranked:rank,methodology:'FDIC-REVERIFY-v1'});
  return getFdicReverificationRankings(env,projectId);
}

export async function getFdicReverificationRankings(env,projectId,{limit=81}={}){
  const rows=await all(env.DB,`SELECT r.*,e.episode_name,e.year,l.institution_name FROM fdic_reverification_rankings r JOIN empirical_episodes e ON e.id=r.episode_id LEFT JOIN fdic_episode_links l ON l.episode_id=r.episode_id AND l.project_id=r.project_id WHERE r.project_id=? ORDER BY CASE r.priority_level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,COALESCE(r.rank_num,999),e.year LIMIT ?`,[projectId,limit]);
  const summary=await one(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN priority_level='CRITICAL' THEN 1 ELSE 0 END) critical,SUM(CASE WHEN priority_level='HIGH' THEN 1 ELSE 0 END) high,SUM(CASE WHEN priority_level='MEDIUM' THEN 1 ELSE 0 END) medium,SUM(CASE WHEN priority_level='LOW' THEN 1 ELSE 0 END) low,SUM(CASE WHEN priority_level='INSUFFICIENT' THEN 1 ELSE 0 END) insufficient,AVG(discrepancy_score) mean_score FROM fdic_reverification_rankings WHERE project_id=?`,[projectId]);
  return {summary:summary||{},rows,methodology:{version:'FDIC-REVERIFY-v1',ranking:'mean empirical percentile of available absolute discrepancy dimensions; provenance is a tie-break/context flag rather than a numeric weight',concentration:'|panel concentration C - FDIC state-market HHI|; market definitions may differ, so diagnostic only',deposit:'|panel peak_outflow - FDIC maximum quarterly peak-to-trough deposit drawdown over year-1..year|; measurement windows differ, so diagnostic proxy',priority:'CRITICAL >=80th percentile aggregate; HIGH >=67th; MEDIUM >=33rd; LOW below 33rd; INSUFFICIENT when no comparable dimension'}};
}

export async function fdicStatus(env,projectId){
  // Status dashboard used to issue 9 sequential reads. D1 batch keeps the same rows
  // but performs one database round-trip; this endpoint is called often by the UI.
  const q=[
    env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN match_status='confirmed' THEN 1 ELSE 0 END) confirmed,SUM(CASE WHEN match_status='pending' THEN 1 ELSE 0 END) pending FROM fdic_episode_links WHERE project_id=?`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) rows,COUNT(DISTINCT episode_id) episodes,MIN(repdte) first_date,MAX(repdte) last_date FROM fdic_financial_observations WHERE project_id=?`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) rows,COUNT(DISTINCT episode_id) episodes,MIN(year) first_year,MAX(year) last_year FROM fdic_sod_observations WHERE project_id=?`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) rows,COUNT(DISTINCT episode_id) episodes FROM fdic_market_metrics WHERE project_id=?`).bind(projectId),
    env.DB.prepare(`SELECT l.id,l.episode_id,e.episode_name,e.year,l.cert,l.institution_name,l.match_status,l.match_method,l.match_score,l.candidate_json FROM fdic_episode_links l JOIN empirical_episodes e ON e.id=l.episode_id WHERE l.project_id=? ORDER BY CASE l.match_status WHEN 'confirmed' THEN 0 ELSE 1 END,e.year,e.episode_name LIMIT 100`).bind(projectId),
    env.DB.prepare(`SELECT m.*,e.episode_name FROM fdic_market_metrics m JOIN empirical_episodes e ON e.id=m.episode_id WHERE m.project_id=? ORDER BY m.updated_at DESC LIMIT 30`).bind(projectId),
    env.DB.prepare(`SELECT r.*,e.episode_name,e.year,l.institution_name FROM fdic_reverification_rankings r JOIN empirical_episodes e ON e.id=r.episode_id LEFT JOIN fdic_episode_links l ON l.episode_id=r.episode_id AND l.project_id=r.project_id WHERE r.project_id=? ORDER BY CASE r.priority_level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,COALESCE(r.rank_num,999),e.year LIMIT 10`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN priority_level='CRITICAL' THEN 1 ELSE 0 END) critical,SUM(CASE WHEN priority_level='HIGH' THEN 1 ELSE 0 END) high,SUM(CASE WHEN priority_level='MEDIUM' THEN 1 ELSE 0 END) medium,SUM(CASE WHEN priority_level='LOW' THEN 1 ELSE 0 END) low,SUM(CASE WHEN priority_level='INSUFFICIENT' THEN 1 ELSE 0 END) insufficient,AVG(discrepancy_score) mean_score FROM fdic_reverification_rankings WHERE project_id=?`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN review_status='RESOLVED' THEN 1 ELSE 0 END) resolved,SUM(CASE WHEN review_status='IN_REVIEW' THEN 1 ELSE 0 END) in_review,SUM(CASE WHEN review_status='ESCALATED' THEN 1 ELSE 0 END) escalated FROM fdic_reverification_reviews WHERE project_id=?`).bind(projectId),
    env.DB.prepare(`SELECT v.review_status,v.cause_code,v.recommended_action,v.reviewer_name,v.evidence_revision,v.reviewed_at,v.updated_at,e.episode_name,e.year,r.priority_level,r.rank_num FROM fdic_reverification_reviews v JOIN empirical_episodes e ON e.id=v.episode_id JOIN fdic_reverification_rankings r ON r.episode_id=v.episode_id AND r.project_id=v.project_id WHERE v.project_id=? ORDER BY CASE v.review_status WHEN 'RESOLVED' THEN 0 WHEN 'ESCALATED' THEN 1 ELSE 2 END,COALESCE(r.rank_num,999) LIMIT 30`).bind(projectId)
  ];
  const b=await env.DB.batch(q);
  let rr;
  if(b.every(x=>Array.isArray(x?.results))) rr=b.map(x=>x.results);
  else {
    // node/sqlite test shim executes SELECT batches without returning rows; production D1
    // returns result sets. Fallback keeps compatibility without affecting production reads.
    rr=await Promise.all([
      all(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN match_status='confirmed' THEN 1 ELSE 0 END) confirmed,SUM(CASE WHEN match_status='pending' THEN 1 ELSE 0 END) pending FROM fdic_episode_links WHERE project_id=?`,[projectId]),
      all(env.DB,`SELECT COUNT(*) rows,COUNT(DISTINCT episode_id) episodes,MIN(repdte) first_date,MAX(repdte) last_date FROM fdic_financial_observations WHERE project_id=?`,[projectId]),
      all(env.DB,`SELECT COUNT(*) rows,COUNT(DISTINCT episode_id) episodes,MIN(year) first_year,MAX(year) last_year FROM fdic_sod_observations WHERE project_id=?`,[projectId]),
      all(env.DB,`SELECT COUNT(*) rows,COUNT(DISTINCT episode_id) episodes FROM fdic_market_metrics WHERE project_id=?`,[projectId]),
      all(env.DB,`SELECT l.id,l.episode_id,e.episode_name,e.year,l.cert,l.institution_name,l.match_status,l.match_method,l.match_score,l.candidate_json FROM fdic_episode_links l JOIN empirical_episodes e ON e.id=l.episode_id WHERE l.project_id=? ORDER BY CASE l.match_status WHEN 'confirmed' THEN 0 ELSE 1 END,e.year,e.episode_name LIMIT 100`,[projectId]),
      all(env.DB,`SELECT m.*,e.episode_name FROM fdic_market_metrics m JOIN empirical_episodes e ON e.id=m.episode_id WHERE m.project_id=? ORDER BY m.updated_at DESC LIMIT 30`,[projectId]),
      all(env.DB,`SELECT r.*,e.episode_name,e.year,l.institution_name FROM fdic_reverification_rankings r JOIN empirical_episodes e ON e.id=r.episode_id LEFT JOIN fdic_episode_links l ON l.episode_id=r.episode_id AND l.project_id=r.project_id WHERE r.project_id=? ORDER BY CASE r.priority_level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,COALESCE(r.rank_num,999),e.year LIMIT 10`,[projectId]),
      all(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN priority_level='CRITICAL' THEN 1 ELSE 0 END) critical,SUM(CASE WHEN priority_level='HIGH' THEN 1 ELSE 0 END) high,SUM(CASE WHEN priority_level='MEDIUM' THEN 1 ELSE 0 END) medium,SUM(CASE WHEN priority_level='LOW' THEN 1 ELSE 0 END) low,SUM(CASE WHEN priority_level='INSUFFICIENT' THEN 1 ELSE 0 END) insufficient,AVG(discrepancy_score) mean_score FROM fdic_reverification_rankings WHERE project_id=?`,[projectId]),
      all(env.DB,`SELECT COUNT(*) total,SUM(CASE WHEN review_status='RESOLVED' THEN 1 ELSE 0 END) resolved,SUM(CASE WHEN review_status='IN_REVIEW' THEN 1 ELSE 0 END) in_review,SUM(CASE WHEN review_status='ESCALATED' THEN 1 ELSE 0 END) escalated FROM fdic_reverification_reviews WHERE project_id=?`,[projectId]),
      all(env.DB,`SELECT v.review_status,v.cause_code,v.recommended_action,v.reviewer_name,v.evidence_revision,v.reviewed_at,v.updated_at,e.episode_name,e.year,r.priority_level,r.rank_num FROM fdic_reverification_reviews v JOIN empirical_episodes e ON e.id=v.episode_id JOIN fdic_reverification_rankings r ON r.episode_id=v.episode_id AND r.project_id=v.project_id WHERE v.project_id=? ORDER BY CASE v.review_status WHEN 'RESOLVED' THEN 0 WHEN 'ESCALATED' THEN 1 ELSE 2 END,COALESCE(r.rank_num,999) LIMIT 30`,[projectId])
    ]);
  }
  const rows=i=>rr[i]||[];
  const first=i=>rows(i)[0]||{};
  const linkCounts=first(0),fin=first(1),sod=first(2),metrics=first(3),links=rows(4),latestMetrics=rows(5);
  const reverification={summary:first(7),rows:rows(6),methodology:{version:'FDIC-REVERIFY-v1',ranking:'mean empirical percentile of available absolute discrepancy dimensions; provenance is a tie-break/context flag rather than a numeric weight',concentration:'|panel concentration C - FDIC state-market HHI|; market definitions may differ, so diagnostic only',deposit:'|panel peak_outflow - FDIC maximum quarterly peak-to-trough deposit drawdown over year-1..year|; measurement windows differ, so diagnostic proxy',priority:'CRITICAL >=80th percentile aggregate; HIGH >=67th; MEDIUM >=33rd; LOW below 33rd; INSUFFICIENT when no comparable dimension'}};
  const reviews=first(8),reviewRows=rows(9);
  return {links:{total:Number(linkCounts?.total||0),confirmed:Number(linkCounts?.confirmed||0),pending:Number(linkCounts?.pending||0),rows:links},financials:fin||{},sod:sod||{},market_metrics:{...(metrics||{}),rows_detail:latestMetrics},reverification,reviews:{summary:reviews||{},rows:reviewRows},methodology:{financials:'CERT-linked quarterly FDIC Financials, episode year-1 through episode year; stored as verification covariates',sod:'CERT-linked SOD at episode year; optional state-market HHI uses all institutions in target bank primary deposit state',promotion:'FDIC-derived measures do not overwrite thesis concentration/peak_outflow automatically'}};
}


const REVERIFY_CHECKLIST=[
  {id:'cert_link',label:'FDIC CERT 연결과 기관명이 원 사례와 일치하는지 확인'},
  {id:'panel_source',label:'논문/패널 원자료와 derivation rule을 확인'},
  {id:'financial_coverage',label:'FDIC Financials 분기 커버리지와 단위를 확인'},
  {id:'sod_market',label:'SOD 시장 정의(state HHI)가 논문 C와 다른 범위임을 확인'},
  {id:'concentration_explained',label:'concentration discrepancy 원인을 설명'},
  {id:'deposit_explained',label:'deposit dynamics discrepancy 원인을 설명'},
  {id:'primary_crosscheck',label:'가능한 primary source로 교차검증'},
  {id:'decision_recorded',label:'패널 유지/수정후보/추가자료 필요 결론을 기록'}
];

function inferReverificationCauses(row,finSummary){
  const out=[];
  const cg=toNum(row?.concentration_gap),dg=toNum(row?.deposit_gap),score=toNum(row?.discrepancy_score);
  if(Number.isFinite(cg)&&cg>=0.10)out.push({code:'MARKET_DEFINITION',label:'시장 정의 차이',why:'논문 concentration C와 FDIC state-market HHI의 지리·기관 범위가 다를 가능성'});
  if(Number.isFinite(dg)&&dg>=0.05)out.push({code:'TIME_WINDOW',label:'측정기간 차이',why:'논문 peak_outflow와 FDIC 분기 peak-to-trough drawdown의 시간창이 다름'});
  if(Number.isFinite(dg)&&dg>=0.05)out.push({code:'ACCOUNTING_DEFINITION',label:'예금 정의 차이',why:'FDIC total/domestic deposits와 논문에서 재구성한 outflow 분모·범위가 다를 수 있음'});
  if(row?.provenance_type!=='verified')out.push({code:'PANEL_RECONSTRUCTION',label:'재구성값 오차',why:'해당 episode가 primary-source verified가 아니므로 derivation error 가능성'});
  if(Number(finSummary?.deposit_points||0)<4)out.push({code:'LIMITED_COVERAGE',label:'Financials 커버리지 부족',why:'분기 관측점이 4개 미만이어서 peak drawdown 진단이 불안정할 수 있음'});
  if(Number(row?.match_score||1)<0.95)out.push({code:'CERT_LINK',label:'CERT 연결 재확인',why:'기관 매칭 점수가 완전 일치 수준이 아니므로 linkage 자체를 재검토할 가치가 있음'});
  if(Number.isFinite(score)&&score>=0.80)out.push({code:'MULTIPLE',label:'복합 원인 가능성',why:'두 discrepancy 차원의 결합 점수가 상위 20%이므로 단일 원인으로 단정하지 않음'});
  if(!out.length)out.push({code:'UNKNOWN',label:'추가 조사 필요',why:'자동 규칙으로 특정 원인을 제안할 근거가 충분하지 않음'});
  return out;
}

export async function getFdicReverificationWorkbench(env,projectId,episodeId){
  const row=await one(env.DB,`SELECT r.*,e.episode_name,e.year,e.digital_adoption,e.severity,e.failed,e.source_note,e.metadata_json,
    l.institution_name,l.match_status,l.match_method,l.match_score,l.candidate_json,
    m.market_type,m.market_key,m.bank_count,m.total_deposits,m.target_bank_share,m.quality_json
    FROM fdic_reverification_rankings r JOIN empirical_episodes e ON e.id=r.episode_id
    LEFT JOIN fdic_episode_links l ON l.project_id=r.project_id AND l.episode_id=r.episode_id
    LEFT JOIN fdic_market_metrics m ON m.project_id=r.project_id AND m.episode_id=r.episode_id
    WHERE r.project_id=? AND r.episode_id=? ORDER BY m.updated_at DESC LIMIT 1`,[projectId,episodeId]);
  if(!row)throw new Error('reverification_episode_not_found');
  const financials=await all(env.DB,`SELECT repdte,asset,deposits_total,deposits_domestic,uninsured_deposits,equity,payload_json,fetched_at FROM fdic_financial_observations WHERE project_id=? AND episode_id=? ORDER BY repdte`,[projectId,episodeId]);
  const sod=await all(env.DB,`SELECT year,cert,branch_num,state,county,cbsa,branch_deposits,payload_json,fetched_at FROM fdic_sod_observations WHERE project_id=? AND episode_id=? ORDER BY branch_deposits DESC LIMIT 250`,[projectId,episodeId]);
  const finSummary=summarizeFinancialRows(financials.map(x=>({REPDTE:x.repdte,DEPDOM:x.deposits_domestic,DEP:x.deposits_total,ASSET:x.asset})));
  const review=await one(env.DB,`SELECT * FROM fdic_reverification_reviews WHERE project_id=? AND episode_id=?`,[projectId,episodeId]);
  return {
    episode:{id:row.episode_id,name:row.episode_name,year:row.year,provenance_type:row.provenance_type,concentration:row.original_concentration,peak_outflow:row.original_peak_outflow,digital_adoption:row.digital_adoption,severity:row.severity,failed:row.failed,source_note:row.source_note,raw:safeObj(row.metadata_json)},
    ranking:{rank_num:row.rank_num,priority_level:row.priority_level,discrepancy_score:row.discrepancy_score,fdic_hhi:row.fdic_hhi,concentration_gap:row.concentration_gap,concentration_percentile:row.concentration_percentile,fdic_peak_drawdown:row.fdic_peak_drawdown,deposit_gap:row.deposit_gap,deposit_percentile:row.deposit_percentile,financial_points:row.financial_points,peak_drawdown_date:row.peak_drawdown_date,reasons:safeObj(row.reason_json)},
    link:{cert:row.cert,institution_name:row.institution_name,match_status:row.match_status,match_method:row.match_method,match_score:row.match_score,candidates:safeObj(row.candidate_json)},
    market:{type:row.market_type,key:row.market_key,hhi:row.fdic_hhi,bank_count:row.bank_count,total_deposits:row.total_deposits,target_bank_share:row.target_bank_share,quality:safeObj(row.quality_json)},
    financials:{summary:finSummary,rows:financials.map(x=>({...x,payload:safeObj(x.payload_json)}))},
    sod:{rows:sod.map(x=>({...x,payload:safeObj(x.payload_json)})),returned:sod.length},
    suggested_causes:inferReverificationCauses({...row,match_score:row.match_score},finSummary),
    checklist:REVERIFY_CHECKLIST,
    review:review?{...review,checklist:safeObj(review.checklist_json),resolution:safeObj(review.resolution_json)}:{review_status:'OPEN',cause_code:null,cause_note:'',checklist:{},reviewer_name:'',reviewer_note:'',recommended_action:'NO_CHANGE',resolution:{}}
  };
}

function safeObj(v){try{return typeof v==='string'?JSON.parse(v||'{}'):(v||{});}catch{return {};}}

export async function saveFdicReverificationReview(env,projectId,episodeId,input={}){
  const exists=await one(env.DB,`SELECT e.id,r.priority_level FROM empirical_episodes e JOIN fdic_reverification_rankings r ON r.episode_id=e.id AND r.project_id=e.project_id WHERE e.project_id=? AND e.id=?`,[projectId,episodeId]);
  if(!exists)throw new Error('reverification_episode_not_found');
  const allowedStatus=new Set(['OPEN','IN_REVIEW','RESOLVED','ESCALATED']);
  const allowedAction=new Set(['NO_CHANGE','KEEP_PANEL','UPDATE_PROVENANCE','REPLACE_CANDIDATE','NEED_PRIMARY_SOURCE','NEED_METHOD_REVIEW']);
  const status=allowedStatus.has(String(input.review_status||''))?String(input.review_status):'IN_REVIEW';
  const action=allowedAction.has(String(input.recommended_action||''))?String(input.recommended_action):'NO_CHANGE';
  const checklist=(input.checklist&&typeof input.checklist==='object')?input.checklist:{};
  const known=new Set(REVERIFY_CHECKLIST.map(x=>x.id));
  const cleaned={}; for(const [k,v] of Object.entries(checklist))if(known.has(k))cleaned[k]=!!v;
  const complete=REVERIFY_CHECKLIST.every(x=>cleaned[x.id]===true);
  if(status==='RESOLVED'&&!complete)throw new Error('reverification_checklist_incomplete');
  if(status==='RESOLVED'&&!String(input.reviewer_note||'').trim())throw new Error('reverification_note_required');
  const now=nowIso(),old=await one(env.DB,`SELECT * FROM fdic_reverification_reviews WHERE project_id=? AND episode_id=?`,[projectId,episodeId]);
  let evidenceRevision=old?.evidence_revision||null;
  const id=old?.id||uid('fdicreview');
  await run(env.DB,`INSERT INTO fdic_reverification_reviews(id,project_id,episode_id,review_status,cause_code,cause_note,checklist_json,reviewer_name,reviewer_note,recommended_action,resolution_json,evidence_revision,reviewed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,episode_id) DO UPDATE SET review_status=excluded.review_status,cause_code=excluded.cause_code,cause_note=excluded.cause_note,checklist_json=excluded.checklist_json,reviewer_name=excluded.reviewer_name,reviewer_note=excluded.reviewer_note,recommended_action=excluded.recommended_action,resolution_json=excluded.resolution_json,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at`,[
    id,projectId,episodeId,status,String(input.cause_code||''),String(input.cause_note||''),JSON.stringify(cleaned),String(input.reviewer_name||''),String(input.reviewer_note||''),action,JSON.stringify(input.resolution||{}),evidenceRevision,status==='RESOLVED'?now:null,old?.created_at||now,now]);
  await audit(env,projectId,'user','fdic.reverification.review.saved','empirical_episode',episodeId,{review_status:status,cause_code:input.cause_code||'',recommended_action:action,checklist_complete:complete});
  return {id,review_status:status,checklist_complete:complete,recommended_action:action,needs_evidence_registration:status==='RESOLVED'&&old?.review_status!=='RESOLVED'};
}

export async function attachFdicReviewEvidenceRevision(env,projectId,episodeId,evidenceRevision){
  await run(env.DB,`UPDATE fdic_reverification_reviews SET evidence_revision=?,updated_at=? WHERE project_id=? AND episode_id=?`,[Number(evidenceRevision),nowIso(),projectId,episodeId]);
}
