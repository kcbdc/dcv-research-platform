import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {__test as engine} from '../src/lib/compute.js';
import {evaluateDoctoralRigor} from '../src/lib/doctoral_rigor.js';
import {replicationParticipantAllowed} from '../src/lib/replication.js';

test('migration 0024 installs durable independent replication ledger',()=>{
 const DB=makeDb();const cols=DB.raw.prepare('PRAGMA table_info(independent_replications)').all().map(x=>x.name);
 for(const c of ['source_cycle','replication_cycle','source_candidate_id','source_protocol_hash','replication_protocol_hash','seed_salt','scenario_salt','status'])assert.ok(cols.includes(c),c);
});

test('replication holdout scenarios are deterministic per salt and different across salts',()=>{
 const base=[{key:'a',name:'A',severity:.7,concentration:.8,digital:.9,volatility:1,delay_multiplier:1,loss_multiplier:1,rho:.82,process_noise:.03,shift_magnitude:.1}];
 const a=engine.replicationHoldoutScenarios(base,'salt-a'),b=engine.replicationHoldoutScenarios(base,'salt-a'),c=engine.replicationHoldoutScenarios(base,'salt-b');
 assert.deepEqual(a,b);assert.notDeepEqual(a,c);assert.match(a[0].provenance,/independent_holdout_v1/);assert.equal(a[0].validation_group,'Independent replication');
});

test('doctoral rigor requires holdout lock, disjoint seeds, preregistered scenarios and fresh participant identity',()=>{
 const common={cycle:3,protocol:{status:'FROZEN',frozen_at:'2026-01-01',protocol_hash:'ph_test'},first_run_at:'2026-01-02',orthogonality:{max_cramers_v:1},seed_audit:{independent:true,collisions:0},confirmation_n:600,confirmation_realized:{runs:1,non_queue_runs:0,candidates:1,min_candidate_episodes:600},human_realized:{participants:32,required_participants:32,correct_trials:300,required_correct:300,wrong_trials:200,required_wrong:200,discrimination_ci_lo:.16,required_delta:.15},post_start_definition_versions:0,replication_mode:'independent_replication_v1',replication_source_cycle:2};
 const good=evaluateDoctoralRigor({...common,replication_lock_ok:true,replication_seed_collisions:0,replication_scenario_mode:'deterministic_holdout_perturbation_v1',replication_human_overlap:0});assert.equal(good.hard_pass,true);
 const bad=evaluateDoctoralRigor({...common,replication_lock_ok:false,replication_seed_collisions:1,replication_scenario_mode:'legacy',replication_human_overlap:1});assert.equal(bad.hard_pass,false);for(const id of ['holdout_resampling_lock','holdout_seed_family_disjoint','holdout_scenarios_preregistered','holdout_fresh_human_identifier'])assert.ok(bad.checks.some(x=>x.id===id&&!x.pass),id);
});

test('replication human sample rejects participants seen in the source cycle',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
 DB.raw.prepare('UPDATE projects SET research_cycle=2 WHERE id=?').run(id);
 DB.raw.prepare(`INSERT INTO independent_replications(id,project_id,source_cycle,replication_cycle,source_candidate_id,locked_design_json,locked_constraints_json,locked_benchmark_json,locked_validation_json,seed_salt,scenario_salt,status,started_at,result_json) VALUES('rep1',?,1,2,'c0','{}','{}','{}','{}','s','q','RUNNING','2026-01-01','{}')`).run(id);
 DB.raw.prepare(`INSERT INTO reviewer_trials(id,project_id,participant_hash,confidence,ai_correct,recommendation,task_json,status,research_cycle,evidence_revision,created_at,protocol_version,trial_phase,ordinal,attention_check) VALUES('oldtrial',?,'same-person',.75,1,1,'{}','done',1,0,'2026-01-01','main_v2','main',1,0)`).run(id);
 const old=await replicationParticipantAllowed({DB},id,'same-person',2),fresh=await replicationParticipantAllowed({DB},id,'new-person',2);
 assert.equal(old.allowed,false);assert.equal(old.reason,'replication_requires_fresh_participant');assert.equal(fresh.allowed,true);
});
