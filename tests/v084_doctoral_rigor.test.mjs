import test from 'node:test';
import assert from 'node:assert/strict';
import {designOrthogonality,seedFamilyAudit,evaluateDoctoralRigor} from '../src/lib/doctoral_rigor.js';

test('doctoral rigor detects confounded nuisance design',()=>{
  const bad=Array.from({length:12},(_,i)=>({sigma:[.03,.05,.1][i%3],tau:[0,1,2][i%3],delay_d:[0,1,2,4][i%4],adjust_m:[.08,.15,.25][i%3],authority_k:2+i%2}));
  assert.ok(designOrthogonality(bad).max_cramers_v>.5);
});

test('confirmation seeds must be independent from adaptive phases',()=>{
  assert.equal(seedFamilyAudit([{candidate_id:'a',phase:'exploration',seed:1},{candidate_id:'a',phase:'confirmation',seed:2}]).independent,true);
  assert.equal(seedFamilyAudit([{candidate_id:'a',phase:'exploration',seed:1},{candidate_id:'a',phase:'confirmation',seed:1}]).independent,false);
});

test('hard doctoral gate passes only with realized evidence',()=>{
  const r=evaluateDoctoralRigor({cycle:2,protocol:{status:'FROZEN',frozen_at:'2026-01-01',protocol_hash:'ph_test'},first_run_at:'2026-01-02',orthogonality:{max_cramers_v:.01},seed_audit:{independent:true,collisions:0},confirmation_n:300,confirmation_realized:{runs:3,non_queue_runs:0,candidates:1,min_candidate_episodes:300},human_realized:{participants:32,required_participants:32,correct_trials:300,required_correct:300,wrong_trials:200,required_wrong:200,discrimination_ci_lo:.16,required_delta:.15},post_start_definition_versions:0,robust_complete:10,robust_missing:0});
  assert.equal(r.hard_pass,true);assert.equal(r.hard_passed,r.hard_total);
});

test('hard doctoral gate rejects seed collision and weak realized human discrimination',()=>{
  const r=evaluateDoctoralRigor({cycle:2,protocol:{status:'FROZEN',frozen_at:'2026-01-01',protocol_hash:'ph_test'},first_run_at:'2026-01-02',orthogonality:{max_cramers_v:.01},seed_audit:{independent:false,collisions:1},confirmation_n:300,confirmation_realized:{runs:1,non_queue_runs:0,candidates:1,min_candidate_episodes:300},human_realized:{participants:32,required_participants:32,correct_trials:300,required_correct:300,wrong_trials:200,required_wrong:200,discrimination_ci_lo:.10,required_delta:.15},post_start_definition_versions:0});
  assert.equal(r.hard_pass,false);assert.ok(r.checks.some(x=>x.id==='independent_confirmation_seed_family'&&!x.pass));assert.ok(r.checks.some(x=>x.id==='human_discrimination_realized'&&!x.pass));
});
