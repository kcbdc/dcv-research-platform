import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {submitHumanQuiz,humanProtocolHash,issueHumanInvite,__test as ht} from '../src/lib/human_trials.js';
import {fitMixedLogitApprox} from '../src/lib/reviewer.js';
import {bust} from '../src/lib/memo.js';
async function quizPass(env,projectId,participant){const inv=await issueHumanInvite(env,projectId,{});return submitHumanQuiz(env,projectId,participant,[true,false,true,false,true],inv.invite_token);}


test('admin API fails closed when ADMIN_TOKEN is not configured, while participant quiz stays public',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
 const inv=await issueHumanInvite({DB},id,{});
 const admin=await worker.fetch(new Request('https://x/api/projects'),{DB},{});assert.equal(admin.status,503);
 const q=await worker.fetch(new Request(`https://x/api/projects/${id}/reviewer-quiz`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({participant_hash:'public-participant-01',answers:[true,false,true,false,true],invite_token:inv.invite_token})}),{DB},{});
 assert.equal(q.status,201);const body=await q.json();assert.equal(body.status,'PASS');assert.match(body.session_token,/^hs_/);
 const denied=await worker.fetch(new Request(`https://x/api/projects/${id}/reviewer-trials`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({participant_hash:'public-participant-01'})}),{DB},{});assert.equal(denied.status,401);
 const ok=await worker.fetch(new Request(`https://x/api/projects/${id}/reviewer-trials`,{method:'POST',headers:{'content-type':'application/json','x-human-session':body.session_token},body:JSON.stringify({participant_hash:'public-participant-01'})}),{DB},{});assert.equal(ok.status,201);
});

test('human protocol hash is derived from actual settings and changes when preregistered QC settings change',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});let env={DB};const h1=await humanProtocolHash(env,id);
 const row=DB.raw.prepare('SELECT id,content_json FROM definitions WHERE project_id=? ORDER BY version DESC LIMIT 1').get(id),j=JSON.parse(row.content_json);j.validation={...(j.validation||{}),human_fast_ms:901};DB.raw.prepare('UPDATE definitions SET content_json=? WHERE id=?').run(JSON.stringify(j),row.id);bust(env,id);env={DB};const h2=await humanProtocolHash(env,id);assert.match(h1,/^[a-f0-9]{64}$/);assert.match(h2,/^[a-f0-9]{64}$/);assert.notEqual(h1,h2);
});

test('main task uses noisy cues rather than deterministic amount/limit arithmetic and attention is a separate phase',()=>{
 const t=ht.makeTask('participant-xyz','main',1,{cue_noise_sd:.18});assert.equal(t.attention_check,0);assert.equal(t.task.amount,undefined);assert.equal(t.task.limit,undefined);assert.ok(['낮음','중간','높음'].includes(t.task.risk_band));const a=ht.makeTask('participant-xyz','attention',1,{cue_noise_sd:.18});assert.equal(a.attention_check,1);assert.match(a.task.decision_prompt,/품질 확인/);
});

test('operational reviewer model includes confidence interaction and participant heterogeneity',()=>{
 const rows=[];for(let p=0;p<12;p++)for(const conf of [.55,.75,.92])for(let i=0;i<10;i++){const ai=i<6?1:0;const accept=ai?((i+p)%5!==0):((i+p)%5===0);rows.push({participant_hash:`p${p}`,ai_confidence:conf,ai_correct:ai,human_accept:accept?1:0});}
 const m=fitMixedLogitApprox(rows);assert.equal(m.status,'CONFIRM');assert.ok(Number.isFinite(m.coefficients.ai_correct));assert.ok(Number.isFinite(m.coefficients.ai_correct_x_confidence));assert.ok(Number.isFinite(m.participant_intercept_sd));
});

test('main schedule has exact 6 correct / 4 wrong in every confidence stratum',()=>{const rows=ht.mainSchedule('p-schedule');for(const c of [.55,.75,.92]){const x=rows.filter(r=>r.confidence===c);assert.equal(x.length,10);assert.equal(x.filter(r=>r.ai_correct).length,6);assert.equal(x.filter(r=>!r.ai_correct).length,4);}});
