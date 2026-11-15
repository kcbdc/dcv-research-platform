import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { registerEvidence, setHumanFreeze, isHumanFrozen, assertNotHumanFrozen } from '../src/lib/evidence.js';

const now=()=>new Date().toISOString();
async function base(){
  const DB=makeDb(),env={DB};
  await DB.prepare(`INSERT INTO projects(id,name,status,current_stage,auto_run,auto_approve,created_at,updated_at,candidate_count,reviewer_obs_count) VALUES('p','x','complete','report',1,1,?,?,1,0)`).bind(now(),now()).run();
  await DB.prepare(`INSERT INTO design_candidates(id,project_id,sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,status,estimator,evidence_status,created_at,research_cycle) VALUES('c','p',.05,0,.35,2,1,.1,.1,'confirmed_feasible','ema','FEASIBLE',?,1)`).bind(now()).run();
  await DB.prepare(`INSERT INTO approvals(id,project_id,candidate_id,decision,evidence_level,basis_json,automatic,created_at,research_cycle,evidence_revision) VALUES('a','p','c','SCIENTIFICALLY_APPROVED','A','{}',0,?,1,0)`).bind(now()).run();
  await DB.prepare(`INSERT INTO reports(id,project_id,kind,title,content_markdown,data_json,created_at,research_cycle,evidence_revision) VALUES('r','p','paper_summary','x','x','{}',?,1,0)`).bind(now()).run();
  return env;
}


test('v0.10.12 freeze blocks new research cycle but still accepts human trial evidence',async()=>{
  const env=await base();
  await setHumanFreeze(env,'p',{enabled:true,reason:'recruitment'});
  assert.equal(await isHumanFrozen(env,'p'),true);
  const r=await registerEvidence(env,'p',{kind:'HUMAN_TRIAL',source:'test'});
  assert.equal(r.research_cycle,1);
  await assert.rejects(()=>registerEvidence(env,'p',{kind:'DESIGN_CHANGE',force_new_cycle:true,source:'test'}),/human_freeze_active/);
  await assert.rejects(()=>registerEvidence(env,'p',{kind:'EXTERNAL_DATA',source:'test'}),/human_freeze_active/);
  await assert.rejects(()=>assertNotHumanFrozen(env,'p'),/human_freeze_active/);
  const p=env.DB.raw.prepare(`SELECT research_cycle,human_freeze,human_freeze_cycle FROM projects WHERE id='p'`).get();
  assert.equal(p.research_cycle,1); assert.equal(p.human_freeze,1); assert.equal(p.human_freeze_cycle,1);
});

test('v0.10.12 releasing the freeze restores normal cycle behaviour',async()=>{
  const env=await base();
  await setHumanFreeze(env,'p',{enabled:true});
  await setHumanFreeze(env,'p',{enabled:false});
  assert.equal(await isHumanFrozen(env,'p'),false);
  const r=await registerEvidence(env,'p',{kind:'DESIGN_CHANGE',force_new_cycle:true,source:'test'});
  assert.equal(r.research_cycle,2);
});
