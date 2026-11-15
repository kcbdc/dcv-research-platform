import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { registerEvidence } from '../src/lib/evidence.js';
import { selectPoolParticipants } from '../src/lib/human_pool.js';

const now=()=>new Date().toISOString();
async function base(){
  const DB=makeDb(),env={DB};
  await DB.prepare(`INSERT INTO projects(id,name,status,current_stage,auto_run,auto_approve,created_at,updated_at,candidate_count,reviewer_obs_count) VALUES('p','x','complete','report',1,1,?,?,1,0)`).bind(now(),now()).run();
  await DB.prepare(`INSERT INTO design_candidates(id,project_id,sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,status,estimator,evidence_status,created_at,research_cycle) VALUES('c','p',.05,0,.35,2,1,.1,.1,'confirmed_feasible','ema','FEASIBLE',?,1)`).bind(now()).run();
  await DB.prepare(`INSERT INTO approvals(id,project_id,candidate_id,decision,evidence_level,basis_json,automatic,created_at,research_cycle,evidence_revision) VALUES('a','p','c','SCIENTIFICALLY_APPROVED','A','{}',0,?,1,0)`).bind(now()).run();
  await DB.prepare(`INSERT INTO reports(id,project_id,kind,title,content_markdown,data_json,created_at,research_cycle,evidence_revision) VALUES('r','p','paper_summary','x','x','{}',?,1,0)`).bind(now()).run();
  return env;
}

test('v0.10.13 auto collectors defer data instead of opening a new research cycle',async()=>{
  const env=await base();
  for(const source of ['scheduled_collector','official_inline_collector']){
    const r=await registerEvidence(env,'p',{kind:'EXTERNAL_DATA',source,detail:{inserted:3}});
    assert.equal(r.deferred,true); assert.equal(r.research_cycle,1); assert.equal(r.full_cycle,false);
  }
  const r2=await registerEvidence(env,'p',{kind:'EMPIRICAL_EPISODE',source:'scheduled_collector'});
  assert.equal(r2.deferred,true);
  const p=env.DB.raw.prepare(`SELECT research_cycle,evidence_revision,deferred_data_events,approval_stale FROM projects WHERE id='p'`).get();
  assert.equal(p.research_cycle,1); assert.equal(p.evidence_revision,0); assert.equal(p.deferred_data_events,3); assert.notEqual(p.approval_stale,1);
});

test('v0.10.13 manual data still opens a cycle, and a not-yet-started project ingests normally',async()=>{
  const env=await base();
  const r=await registerEvidence(env,'p',{kind:'EXTERNAL_DATA',source:'manual_api'});
  assert.equal(r.research_cycle,2);
  const fresh=await base();
  fresh.DB.raw.prepare(`DELETE FROM design_candidates`).run();
  const r2=await registerEvidence(fresh,'p',{kind:'EXTERNAL_DATA',source:'scheduled_collector'});
  assert.ok(!r2.deferred); assert.equal(r2.evidence_revision,1);
});

const row=(h,c,over={})=>({participant_hash:h,research_cycle:c,main_n:30,attention_n:3,hash_ok:1,excluded:0,...over});
test('v0.10.13 pool keeps completed same-protocol prior participants and drops the rest',()=>{
  const trials=[row('a7',7),row('b7',7,{main_n:12}),row('c7',7,{excluded:1}),row('d7',7,{hash_ok:0}),row('e23',23),row('f24',24)];
  const {included,stats}=selectPoolParticipants(trials,[],{cycle:24});
  assert.deepEqual([...included].sort(),['a7','e23','f24']);
  assert.equal(stats.current_completed,1); assert.equal(stats.prior_included,2);
  assert.equal(stats.prior_excluded_incomplete,1); assert.equal(stats.prior_excluded_flagged,1); assert.equal(stats.prior_excluded_protocol_mismatch,1);
  assert.deepEqual(stats.cycles_pooled,[7,23]);
});

test('v0.10.13 pool counts one subject once (current cycle wins, otherwise earliest)',()=>{
  const trials=[row('x7',7),row('x23',23),row('x24',24),row('y7',7),row('y23',23)];
  const sessions=[['x7',7,'S1'],['x23',23,'S1'],['x24',24,'S1'],['y7',7,'S2'],['y23',23,'S2']].map(([participant_hash,research_cycle,subject_hash])=>({participant_hash,research_cycle,subject_hash}));
  const {included,stats}=selectPoolParticipants(trials,sessions,{cycle:24});
  assert.deepEqual([...included].sort(),['x24','y7']);
  assert.equal(stats.deduped_same_subject,3);
});
