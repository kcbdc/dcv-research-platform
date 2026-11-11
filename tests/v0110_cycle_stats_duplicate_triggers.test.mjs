import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {advanceProject} from '../src/lib/orchestrator.js';

const triggers=DB=>DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r=>r.name);
const stats=DB=>DB.raw.prepare('SELECT * FROM project_cycle_stats').get();

test('legacy duplicate cycle-stat triggers are gone (each counter has exactly one writer)',()=>{
  const DB=makeDb(),names=triggers(DB);
  for(const legacy of ['trg_candidate_stats_insert','trg_candidate_stats_update','trg_candidate_stats_delete','trg_sim_stats_insert'])
    assert.ok(!names.includes(legacy),`${legacy} must not coexist with trg_cycle_stats_*`);
  for(const canonical of ['trg_cycle_stats_candidate_insert','trg_cycle_stats_candidate_update','trg_cycle_stats_candidate_delete','trg_cycle_stats_run_insert'])
    assert.ok(names.includes(canonical),`${canonical} missing`);
});

test('candidate and run counters equal the authoritative tables after status changes (no 2x drift)',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:6,reviewer:0,episodes:0});
  DB.raw.exec("DELETE FROM simulation_runs");
  DB.raw.exec("UPDATE design_candidates SET status='confirmed_feasible',evidence_status='FEASIBLE'");
  let s=stats(DB);
  assert.equal(Number(s.candidate_total),6);
  assert.equal(Number(s.candidate_feasible),6);
  DB.raw.exec("UPDATE design_candidates SET status='infeasible',evidence_status='INFEASIBLE' WHERE id IN ('cand_0','cand_1')");
  s=stats(DB);
  assert.equal(Number(s.candidate_feasible),4);
  assert.equal(Number(s.candidate_infeasible),2);
  const ins=DB.raw.prepare("INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,?,1,1,'{}',datetime('now'),0)");
  ins.run('r_a',id,'cand_2','historical');ins.run('r_b',id,'cand_2','stress');
  assert.equal(Number(stats(DB).simulation_total),2);
  assert.equal(Number(stats(DB).simulation_robust),2);
});

test('advance leaves the robust stage and queues validate_project even if the cached feasible counter was inflated',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:6,reviewer:0,episodes:0});
  DB.raw.exec("DELETE FROM simulation_runs; DELETE FROM validations; DELETE FROM approvals; DELETE FROM jobs");
  DB.raw.exec("UPDATE design_candidates SET status='confirmed_feasible',evidence_status='FEASIBLE'");
  const ins=DB.raw.prepare("INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,?,1,1,'{}',datetime('now'),0)");
  for(let i=0;i<6;i++)for(const ph of ['confirmation','historical','stress'])ins.run(`r_${i}_${ph}`,id,`cand_${i}`,ph);
  DB.raw.exec("UPDATE projects SET status='running',current_stage='validate',reviewer_hold_marker=NULL");
  // Reproduce the production drift: the materialized counters are exactly 2x the real values.
  DB.raw.exec("UPDATE project_cycle_stats SET candidate_total=candidate_total*2,candidate_feasible=candidate_feasible*2");
  assert.equal(Number(stats(DB).candidate_feasible),12);
  const r=await advanceProject({DB},id);
  assert.notEqual(r.stage,'robust','must not wait forever for stress runs that already exist');
  assert.ok(DB.raw.prepare("SELECT 1 x FROM jobs WHERE type='validate_project' AND status='queued'").get(),'validate_project must be queued');
  assert.equal(Number(stats(DB).candidate_feasible),6,'cache is repaired from the authoritative table');
  assert.ok(DB.raw.prepare("SELECT 1 x FROM audit_log WHERE action='cycle_stats.repaired'").get(),'repair is audited');
});

test('advance still waits in the robust stage (and queues work) when stress runs are genuinely missing',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:4,reviewer:0,episodes:0});
  DB.raw.exec("DELETE FROM simulation_runs; DELETE FROM validations; DELETE FROM approvals; DELETE FROM jobs");
  DB.raw.exec("UPDATE design_candidates SET status='confirmed_feasible',evidence_status='FEASIBLE'");
  DB.raw.exec("UPDATE projects SET status='running',current_stage='validate',reviewer_hold_marker=NULL");
  const r=await advanceProject({DB},id);
  assert.equal(r.stage,'robust');
  assert.ok(r.queued>0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE type='compute_candidate' AND phase IN ('historical','stress')").get().n,8);
});

test('reviewer observation counter has one writer: N observations -> reviewer_obs_count == N',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
  assert.ok(!triggers(DB).includes('trg_reviewer_obs_project_count_insert'));
  const ins=DB.raw.prepare("INSERT INTO reviewer_observations(id,project_id,participant_hash,ai_confidence,ai_correct,human_accept,response_ms,created_at) VALUES(?,?,?,?,1,1,500,datetime('now'))");
  for(let i=0;i<3;i++)ins.run(`obs${i}`,id,`p${i}`,.7);
  assert.equal(Number(DB.raw.prepare('SELECT reviewer_obs_count n FROM projects WHERE id=?').get(id).n),3);
  DB.raw.exec("DELETE FROM reviewer_observations WHERE id='obs0'");
  assert.equal(Number(DB.raw.prepare('SELECT reviewer_obs_count n FROM projects WHERE id=?').get(id).n),2);
});
