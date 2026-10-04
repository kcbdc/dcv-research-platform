import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {createLabCampaign,processLabTick,getLabStatus,labApi,persistLabPackage} from '../src/lib/lab.js';
import {makeLabPlan,normalizeConfig,validateJournalRow,journalAssessment,validateLabOutput,LAB_ROLES} from '../src/lib/lab_policy.js';
import {readLabSnapshot} from '../src/lib/lab_evidence.js';
import {collectProject} from '../src/lib/collectors.js';
import {cached,bust} from '../src/lib/memo.js';
const makeEnv=async()=>{const DB=makeDb(),pid=await seedProject(DB,{candidates:8,reviewer:35,episodes:12});const calls=[];return {DB,pid,calls,AI:{run:async(model,body)=>{calls.push({model,body});return {response:JSON.stringify({summary:'Reviewed the actual bounded evidence and identified remaining verification requirements.',findings:[],blockers:[],recommendations:['Verify the real human participant count.'],markdown:Array(180).fill('Evidence').join(' '),documents:{cover_letter:'# Cover letter\n\nDraft for author review.',title_page:'# Title page\n\nReal authors pending.',highlights:'# Highlights\n\n- Model conditional delegation boundaries.',appendices:'# Appendices\n\nReproducibility audit.'}})}}}};};
test('300 scheduled tasks preserve 10 roles and 30 daily cycles without fake credentials',()=>{
 const plan=makeLabPlan();assert.equal(plan.length,300);assert.equal(new Set(plan.map(t=>t.role_id)).size,10);assert.equal(plan[299].day,30);assert.equal(plan[299].role_id,'leader');
 assert.equal(LAB_ROLES.filter(r=>r.group==='advisor').length,2);assert.equal(LAB_ROLES.filter(r=>r.group==='collector').length,2);assert.equal(LAB_ROLES.filter(r=>r.group==='analyst').length,2);assert.equal(LAB_ROLES.filter(r=>r.group==='standardizer').length,2);
});
test('journal eligibility needs verified SCIE/SSCI and Q1/Q2 or AIS in all three years',()=>{
 const cfg=normalizeConfig(),row={journal:'Example',metric_year:2023,edition:'SSCI',category:'Economics',quartile:'Q2',ais:null,source_url:'https://jcr.clarivate.com/jcr-jp/journal-profile',verified_by:'Human reviewer'};
 assert.equal(validateJournalRow(row,cfg.metric_years).metric_year,2023);
 assert.throws(()=>validateJournalRow({...row,source_url:'https://example.org'},cfg.metric_years));
 const rows=cfg.metric_years.map(metric_year=>({...row,metric_year}));assert.equal(journalAssessment(rows,cfg.metric_years).eligible,true);
 rows[2].quartile='Q3';assert.equal(journalAssessment(rows,cfg.metric_years).eligible,false);rows[2].ais=.75;assert.equal(journalAssessment(rows,cfg.metric_years).eligible,true);
 assert.equal(journalAssessment(rows.slice(1),cfg.metric_years).eligible,false);
});
test('hallucinated DOI and non-English AI output are rejected',()=>{
 assert.throws(()=>validateLabOutput({summary:'Citation [SRC:10.1234/unknown]'},LAB_ROLES[0],[]),/Unverified/);
 assert.throws(()=>validateLabOutput({summary:'가짜 결과'},LAB_ROLES[0],[]),/English/);
});
test('campaign start is idempotent and only materializes one task',async()=>{
 const env=await makeEnv();const result=await createLabCampaign(env,env.pid);const duplicate=await createLabCampaign(env,env.pid);
 assert.equal(result.id,duplicate.id);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM lab_tasks').get().n,1);
 assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM projects').get().n,1);
});
test('snapshot reuse does one indexed project read and no candidate/episode scan',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);const c=env.DB.raw.prepare('SELECT * FROM lab_campaigns').get(),snapshot=await readLabSnapshot(env,c);
 const log=[],wrapped={...env.DB,prepare:sql=>{log.push(sql);return env.DB.prepare(sql);}};
 const again=await readLabSnapshot({...env,DB:wrapped},{...c,snapshot_json:JSON.stringify(snapshot),snapshot_signature:snapshot.signature,snapshot_at:snapshot.captured_at});
 assert.equal(again.digest,snapshot.digest);assert.equal(log.length,1);assert.match(log[0],/FROM projects p LEFT JOIN project_cycle_stats/);
});
test('only one role runs per tick; another tick before due time is idle',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);const result=await processLabTick(env);assert.equal(result.status,'task_completed');assert.equal(env.calls.length,1);
 assert.equal((await processLabTick(env)).status,'idle');assert.equal(env.calls.length,1);
 const c=env.DB.raw.prepare('SELECT * FROM lab_campaigns').get();assert.equal(c.cursor,1);assert.equal(c.completed_tasks,1);assert.equal(c.lease_token,null);
});
test('concurrent cron deliveries cannot run the same role twice',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);let release;const barrier=new Promise(r=>release=r);env.AI.run=async()=>{await barrier;return {response:'{"summary":"Evidence review completed","blockers":[],"findings":[],"recommendations":[]}'}};
 const first=processLabTick(env);await new Promise(r=>setTimeout(r,20));assert.equal((await processLabTick(env)).status,'idle');release();assert.equal((await first).status,'task_completed');
});
test('writer and leader persist editable sections and submission documents',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);env.DB.raw.prepare("UPDATE lab_campaigns SET cursor=8,next_run_at=?").run(new Date(0).toISOString());
 assert.equal((await processLabTick(env)).status,'task_completed');assert.equal(env.DB.raw.prepare("SELECT section FROM lab_documents").get().section,'abstract');
 env.DB.raw.prepare('UPDATE lab_campaigns SET next_run_at=?').run(new Date(0).toISOString());assert.equal((await processLabTick(env)).status,'task_completed');assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM lab_documents').get().n,5);
});
test('failed AI calls use bounded retries and never persist a fabricated draft',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);env.AI.run=async()=>{throw new Error('provider unavailable')};
 for(let i=0;i<3;i++){await processLabTick(env);env.DB.raw.prepare('UPDATE lab_campaigns SET next_run_at=?').run(new Date(0).toISOString());}
 const c=env.DB.raw.prepare('SELECT cursor,failed_tasks FROM lab_campaigns').get();assert.equal(c.cursor,1);assert.equal(c.failed_tasks,1);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM lab_documents').get().n,0);
});
test('deadline persists a six-document package with honest blockers and chunked download',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);env.DB.raw.prepare('UPDATE lab_campaigns SET deadline_at=?,next_run_at=?').run(new Date(0).toISOString(),new Date(0).toISOString());
 const result=await processLabTick(env);assert.equal(result.status,'completed');assert.equal(result.readiness,'DRAFT_REQUIRES_REVIEW');
 const c=env.DB.raw.prepare('SELECT * FROM lab_campaigns').get(),meta=env.DB.raw.prepare('SELECT * FROM lab_packages').get(),manifest=JSON.parse(meta.manifest_json);
 assert.equal(manifest.files.filter(f=>/^\d_/.test(f.name)).length,6);assert.ok(manifest.readiness.blockers.some(b=>/participants/.test(b)));assert.match(manifest.readiness.acceptance,/Not submitted/);
 const response=await labApi(new Request('https://x/api/projects/'+env.pid+'/lab/download'),env,env.pid,['api','projects',env.pid,'lab','download']);
 assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,meta.size_bytes);assert.ok(c.package_id);
 assert.equal((await processLabTick(env)).status,'idle');
 // Inspect fixture package separately with standard ZIP tooling / reproduction runner.
 fs.mkdirSync('docs/lab-verification',{recursive:true});fs.writeFileSync('docs/lab-verification/submission-fixture.zip',Buffer.concat(env.DB.raw.prepare('SELECT bytes FROM lab_package_chunks ORDER BY chunk_no').all().map(r=>r.bytes)));
});
test('pause revokes lease and status cache avoids repeated role queries',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);await getLabStatus(env,env.pid);
 const log=[],DB={...env.DB,prepare:sql=>{log.push(sql);return env.DB.prepare(sql);}};await getLabStatus({...env,DB},env.pid);const n=log.length;await getLabStatus({...env,DB},env.pid);assert.equal(log.length,n);
 await labApi(new Request('https://x',{method:'POST'}),env,env.pid,['api','projects',env.pid,'lab','pause']);assert.equal((await processLabTick(env)).status,'idle');
});
test('single-flight memo coalesces concurrent reads and failed loads are not cached',async()=>{
 const env={DB:{}};let reads=0;const loader=async()=>{reads++;await new Promise(r=>setTimeout(r,10));return 4;};assert.deepEqual(await Promise.all([cached(env,'p','x',loader),cached(env,'p','x',loader)]),[4,4]);assert.equal(reads,1);
 bust(env,'p');await assert.rejects(cached(env,'p','x',async()=>{throw new Error('failed')}));assert.equal(await cached(env,'p','x',loader),4);
});
test('unchanged scheduled data is deduplicated without per-row D1 read queries',async()=>{
 const env=await makeEnv(),db=env.DB;db.raw.prepare(`INSERT INTO data_sources(id,project_id,name,kind,url,enabled,cadence_minutes,created_at) VALUES('source',?,'test','json','https://example.test',1,15,?)`).run(env.pid,new Date().toISOString());
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify([{value:1,period:'2026'}]),{headers:{'content-type':'application/json'}});
 try{assert.equal((await collectProject(env,env.pid)).inserted,1);assert.equal((await collectProject(env,env.pid)).inserted,0);assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM raw_observations').get().n,1);}finally{globalThis.fetch=old;}
});

test('semantic evidence digest survives timestamp-only updates',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);const c=env.DB.raw.prepare('SELECT * FROM lab_campaigns').get();const before=await readLabSnapshot(env,c);
 env.DB.raw.prepare("UPDATE projects SET updated_at='2099-01-01T00:00:00Z' WHERE id=?").run(env.pid);
 const after=await readLabSnapshot(env,c,{force:true});assert.equal(after.data_digest,before.data_digest);assert.equal(after.signature,before.signature);
});
test('deadline finalization runs within the final cron interval',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);env.DB.raw.prepare('UPDATE lab_campaigns SET deadline_at=?,next_run_at=?').run(new Date(Date.now()+300000).toISOString(),new Date(0).toISOString());
 assert.equal((await processLabTick(env)).status,'completed');assert.equal(env.calls.length,0);
});
test('a lease revoked during package assembly cannot persist orphan chunks',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);env.DB.raw.prepare("UPDATE lab_campaigns SET lease_token='test-lease'").run();
 const c=env.DB.raw.prepare('SELECT * FROM lab_campaigns').get(),snapshot=await readLabSnapshot(env,c),original=env.DB.batch;
 env.DB.batch=async statements=>{env.DB.raw.prepare("UPDATE lab_campaigns SET status='paused',lease_token=NULL").run();return original(statements);};
 const result=await persistLabPackage(env,c,snapshot,{documents:[],sources:[],journals:[],reviews:[]},'test-lease');assert.equal(result.status,'lease_lost');
 assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM lab_packages').get().n,0);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM lab_package_chunks').get().n,0);
});
test('status ETag returns 304 without reloading task history',async()=>{
 const env=await makeEnv();await createLabCampaign(env,env.pid);const parts=['api','projects',env.pid,'lab'];
 const response=await labApi(new Request('https://local/api'),env,env.pid,parts);const etag=response.headers.get('etag');assert.ok(etag);
 assert.equal((await labApi(new Request('https://local/api',{headers:{'if-none-match':etag}}),env,env.pid,parts)).status,304);
});
