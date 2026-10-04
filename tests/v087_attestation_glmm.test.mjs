import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDoctoralRigor} from '../src/lib/doctoral_rigor.js';
import {rowsToCsv} from '../src/lib/glmm_export.js';

const base={cycle:2,protocol:{status:'FROZEN',frozen_at:'2026-01-01',protocol_hash:'ph_live'},first_run_at:'2026-01-02',orthogonality:{max_cramers_v:0},seed_audit:{independent:true,collisions:0},confirmation_n:300,confirmation_realized:{runs:1,non_queue_runs:0,protocol_hash_mismatches:0,candidates:1,min_candidate_episodes:300},human_realized:{participants:32,required_participants:32,correct_trials:300,required_correct:300,wrong_trials:200,required_wrong:200,discrimination_ci_lo:.16,required_delta:.15},post_start_definition_versions:0};

test('doctoral rigor requires runtime confirmation artifacts to attest the frozen protocol hash',()=>{
  const ok=evaluateDoctoralRigor(base);assert.equal(ok.checks.find(x=>x.id==='runtime_protocol_attestation').pass,true);
  const bad=evaluateDoctoralRigor({...base,confirmation_realized:{...base.confirmation_realized,protocol_hash_mismatches:1}});assert.equal(bad.checks.find(x=>x.id==='runtime_protocol_attestation').pass,false);assert.equal(bad.hard_pass,false);
});

test('confirmatory GLMM CSV preserves the preregistered trial-level columns',()=>{
  const csv=rowsToCsv([{participant_id:'p1',ai_correct:1,ai_confidence:.75,confidence_z:0,human_accept:1,server_response_ms:1200,client_response_ms:1180,client_server_abs_diff_ms:20,research_cycle:2,evidence_revision:7}]);
  assert.match(csv,/participant_id,ai_correct,ai_confidence,confidence_z,human_accept,server_response_ms/);
  assert.match(csv,/p1,1,0.75,0,1,1200/);
});
