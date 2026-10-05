import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {submitHumanQuiz,createHumanTrial,recordHumanTrial,issueHumanInvite} from '../src/lib/human_trials.js';
import {buildThesisData} from '../src/lib/thesis.js';
import {checklist} from '../src/lib/report.js';
import {readLabSnapshot} from '../src/lib/lab_evidence.js';
async function quizPass(env,projectId,participant){const inv=await issueHumanInvite(env,projectId,{});return submitHumanQuiz(env,projectId,participant,[true,false,true,false,true],inv.invite_token);}


test('participant identity is scoped by project and human protocol, not research cycle',()=>{
  const js=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(js,/dcv_participant:\$\{projectId\|\|'none'\}:\$\{encodeURIComponent\(protocol\|\|'legacy'\)\}/);
  assert.doesNotMatch(js,/participantStorageKey\(projectId=current,cycle=currentResearchCycle\)/);
  assert.match(js,/newParticipantBtn/);
  assert.match(js,/crypto\.randomUUID\(\)/);
});

test('partial main_v2 sessions are preserved cumulatively but are not promoted to eligible participants',async()=>{
  const DB=makeDb(),projectId=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};
  for(let i=0;i<14;i++){const ph=`participant-${String(i).padStart(2,'0')}`;const q=await quizPass(env,projectId,ph);const t=await createHumanTrial(env,projectId,ph,q.session_token);await recordHumanTrial(env,projectId,{trial_id:t.trial_id,participant_hash:ph,human_accept:i%2===0,response_ms:1200+i},q.session_token);}
  const t=await buildThesisData(env,projectId);assert.equal(t.reviewer.participants,0);assert.equal(t.reviewer.protocol_participants,14);assert.equal(t.reviewer.cumulative_participants,14);assert.equal(t.reviewer.excluded_trials,14);
});

test('research-cycle changes do not relabel incomplete participants as completed evidence',async()=>{
  const DB=makeDb(),projectId=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};const ph='stable-participant-01';const q=await quizPass(env,projectId,ph);const tr=await createHumanTrial(env,projectId,ph,q.session_token);await recordHumanTrial(env,projectId,{trial_id:tr.trial_id,participant_hash:ph,human_accept:true,response_ms:1200},q.session_token);DB.raw.exec('UPDATE projects SET research_cycle=research_cycle+1');const t=await buildThesisData(env,projectId);assert.equal(t.reviewer.participants,0);assert.equal(t.reviewer.cumulative_participants,1);
});

test('10-agent lab snapshot does not count incomplete QC sessions toward the participant gate',async()=>{
  const DB=makeDb(),projectId=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};const ph='lab-participant-01';const q=await quizPass(env,projectId,ph);const tr=await createHumanTrial(env,projectId,ph,q.session_token);await recordHumanTrial(env,projectId,{trial_id:tr.trial_id,participant_hash:ph,human_accept:true,response_ms:1200},q.session_token);const snapshot=await readLabSnapshot(env,{project_id:projectId},{force:true});assert.equal(Number(snapshot.human.participants||0),0);assert.match(snapshot.diagnostics.blockers.join(' | '),/quality-controlled main_v2 human participants/);
});


test('paper checklist distinguishes current-protocol participants from publication-eligible completed participants',async()=>{
  const DB=makeDb(),projectId=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};
  const ph='checklist-participant-01',q=await quizPass(env,projectId,ph),tr=await createHumanTrial(env,projectId,ph,q.session_token);
  await recordHumanTrial(env,projectId,{trial_id:tr.trial_id,participant_hash:ph,human_accept:true,response_ms:1200},q.session_token);
  const t=await buildThesisData(env,projectId),items=checklist(t).join(' | ');
  assert.equal(t.reviewer.protocol_participants,1);
  assert.equal(t.reviewer.participants,0);
  assert.match(items,/규약 대상 참가자는 1명/);
  assert.match(items,/주분석에 포함 가능한 완료 참가자는 0명/);
});
