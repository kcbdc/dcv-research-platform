import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateDoctoralRigor,designOrthogonality} from '../src/lib/doctoral_rigor.js';
import {constraintSensitivityCurve} from '../src/lib/constraint_calibration.js';

test('doctoral rigor requires realized evidence, not settings alone',()=>{
 const base={cycle:2,protocol:{status:'FROZEN',frozen_at:'2026-01-01',protocol_hash:'ph_test'},first_run_at:'2026-01-02',orthogonality:{max_cramers_v:0},seed_audit:{independent:true,collisions:0},confirmation_n:300,confirmation_realized:{runs:1,non_queue_runs:0,candidates:1,min_candidate_episodes:300},human_realized:{participants:32,required_participants:32,correct_trials:300,required_correct:300,wrong_trials:200,required_wrong:200,discrimination_ci_lo:.16,required_delta:.15},post_start_definition_versions:0};
 assert.equal(evaluateDoctoralRigor(base).hard_pass,true);
 assert.equal(evaluateDoctoralRigor({...base,human_realized:{...base.human_realized,discrimination_ci_lo:.01}}).hard_pass,false);
 assert.equal(evaluateDoctoralRigor({...base,confirmation_realized:{...base.confirmation_realized,min_candidate_episodes:299}}).hard_pass,false);
 assert.equal(evaluateDoctoralRigor({...base,post_start_definition_versions:1}).hard_pass,false);
 assert.equal(evaluateDoctoralRigor({...base,confirmation_realized:{...base.confirmation_realized,non_queue_runs:1}}).hard_pass,false);
});

test('full-factor orthogonality audit can see core-factor confounding',()=>{
 const rows=[];for(let i=0;i<24;i++)rows.push({estimator:i%2?'ema':'kalman',alpha:i%2,recovery_w:i%3,sigma:i%2,tau:i%3,delay_d:i%4,adjust_m:i%3,authority_k:i%2});
 const a=designOrthogonality(rows);assert.ok(a.pairs.some(p=>p.a==='estimator'&&p.b==='alpha'));assert.ok(a.max_cramers_v>.5);
});

test('constraint sensitivity reports feasible share across thresholds without selecting one',()=>{
 const rows=[.03,.06,.09].map((fn,i)=>({candidate_id:'c'+i,created_at:String(i),loss_mean:.1,loss_exceed_rate:.02,fp_rate:.01,fn_rate:fn,review_burden:.2,recovery_time:1}));
 const r=constraintSensitivityCurve(rows,{baseConstraints:{loss_max:.18,loss_exceed_max:.1,fp_max:.055,fn_max:.08,review_burden_max:.3,recovery_time_max:2.5},fnGrid:[.04,.08,.12]});
 assert.deepEqual(r.curves.fn_max.map(x=>x.feasible_n),[1,2,3]);assert.equal(r.method,'broad_candidate_threshold_sensitivity_v1');
});
