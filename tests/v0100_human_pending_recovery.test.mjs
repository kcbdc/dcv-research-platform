import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {issueHumanInvite,submitHumanQuiz,createHumanTrial} from '../src/lib/human_trials.js';

async function ready(env,pid,participant='pending-human-01'){
 const inv=await issueHumanInvite(env,pid,{subject_key:'subject-pending-01'});
 const q=await submitHumanQuiz(env,pid,participant,[true,false,true,false,true],inv.invite_token,'fp-1');
 return {participant,token:q.session_token};
}

test('pending practice trial is resumed instead of throwing complete_pending_practice_trial',async()=>{
 const DB=makeDb(),pid=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB};
 const r=await ready(env,pid);
 const a=await createHumanTrial(env,pid,r.participant,r.token);
 const b=await createHumanTrial(env,pid,r.participant,r.token);
 assert.equal(a.phase,'practice');
 assert.equal(b.trial_id,a.trial_id);
 assert.equal(b.resumed_pending,true);
 const n=DB.raw.prepare("SELECT COUNT(*) n FROM reviewer_trials WHERE project_id=? AND participant_hash=? AND status='pending'").get(pid,r.participant).n;
 assert.equal(n,1);
});
