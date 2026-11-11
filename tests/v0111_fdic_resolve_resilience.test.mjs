import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFdicLinks, explainFdicError, bankNameScore, normalizeBankName } from '../src/lib/fdic.js';
import { makeDb } from './helpers/d1shim.mjs';

function seed(names){
  const DB=makeDb(),now='2026-10-01T00:00:00.000Z';
  DB.raw.prepare(`INSERT INTO projects(id,name,description,status,current_stage,auto_run,auto_approve,created_at,updated_at) VALUES('p','p','','active','define',0,0,?,?)`).run(now,now);
  names.forEach((n,i)=>DB.raw.prepare(`INSERT INTO empirical_episodes(id,project_id,episode_name,year,peak_outflow,concentration,digital_adoption,severity,failed,provenance_type,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('e'+i,'p',n,2008,.09,.55,.45,.55,1,'verified','{}',now,now));
  return DB;
}
const ok=data=>new Response(JSON.stringify({data:data.map(d=>({data:d})),meta:{total:data.length}}),{status:200});

test('transient 503 from api.fdic.gov is retried and then succeeds',async()=>{
  const DB=seed(['Washington Mutual Bank']),old=globalThis.fetch;let n=0;
  globalThis.fetch=async()=>++n<3?new Response('busy',{status:503}):ok([{NAME:'Washington Mutual Bank',CERT:32633}]);
  try{const r=await resolveFdicLinks({DB},'p',{});assert.equal(n,3);assert.equal(r.confirmed,1);}finally{globalThis.fetch=old;}
});
test('persistent 503 surfaces a labelled, retryable error (not a bare 503)',async()=>{
  const DB=seed(['Washington Mutual Bank']),old=globalThis.fetch;globalThis.fetch=async()=>new Response('down',{status:503});
  try{await assert.rejects(resolveFdicLinks({DB},'p',{}),e=>{const x=explainFdicError(e);return x.code==='fdic_upstream_unavailable'&&x.retryable;});}finally{globalThis.fetch=old;}
});
test('failures request is field-limited to keep payload and CPU small',async()=>{
  const DB=seed(['Washington Mutual Bank']),old=globalThis.fetch;let url='';
  globalThis.fetch=async u=>{url=String(u);return ok([{NAME:'Washington Mutual Bank',CERT:1}]);};
  try{await resolveFdicLinks({DB},'p',{});assert.match(url,/fields=CERT%2CNAME/);}finally{globalThis.fetch=old;}
});
test('indexed matching equals brute-force bankNameScore ranking and is fast at scale',async()=>{
  const banks=Array.from({length:4000},(_,i)=>({NAME:`First National Bank of Town${i} ${i%97} Savings`,CERT:1000+i}));
  banks.push({NAME:'Washington Mutual Bank',CERT:32633},{NAME:'Washington Federal Savings',CERT:7});
  const eps=['Washington Mutual Bank',...Array.from({length:80},(_,i)=>`Town${i} Savings Bank`)];
  const DB=seed(eps),old=globalThis.fetch;globalThis.fetch=async()=>ok(banks);
  try{
    const t=performance.now();const r=await resolveFdicLinks({DB},'p',{});const ms=performance.now()-t;
    assert.ok(ms<400,`resolve took ${ms}ms`);
    const link=DB.raw.prepare(`SELECT cert,match_status FROM fdic_episode_links WHERE episode_id='e0'`).get();
    assert.equal(link.cert,32633);assert.equal(link.match_status,'confirmed');
    // brute-force reference: best candidate per episode must have the same score
    const best=n=>Math.max(...banks.map(b=>bankNameScore(n,b.NAME)));
    for(const [i,n] of eps.slice(0,10).entries()){const row=DB.raw.prepare(`SELECT match_score FROM fdic_episode_links WHERE episode_id=?`).get('e'+i);if(best(n)>=0.48)assert.ok(Math.abs(row.match_score-best(n))<1e-9,n);else assert.equal(row,undefined);}
  }finally{globalThis.fetch=old;}
});
