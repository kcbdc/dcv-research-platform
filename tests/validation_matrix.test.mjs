import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { seedProject } from './helpers/seed.mjs';
import { refreshValidationMatrix, getValidationMatrix } from '../src/lib/validation_matrix.js';

const now=()=>new Date().toISOString();
const ev=(classification,groups={})=>JSON.stringify({classification,validation_groups:groups});

test('External Validation Matrix separates Synthetic/Historical/Adversarial/BIS/ECB/Human',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0}),cid='cand_0',ts=now();
  DB.raw.prepare(`DELETE FROM simulation_runs WHERE project_id=? AND candidate_id=?`).run(pid,cid);
  const ins=(id,phase,result)=>DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,?,1,100,?,?,0)`).run(id,pid,cid,phase,result,ts);
  ins('c','confirmation',ev('FEASIBLE',{Synthetic:{classification:'FEASIBLE'}}));
  ins('h','historical',ev('FEASIBLE',{Historical:{classification:'FEASIBLE'}}));
  ins('s','stress',ev('UNRESOLVED',{Adversarial:{classification:'FEASIBLE'},BIS:{classification:'INFEASIBLE'},ECB:{classification:'UNRESOLVED'}}));
  DB.raw.prepare(`DELETE FROM validations WHERE project_id=? AND candidate_id=? AND validation_type='human_recompute'`).run(pid,cid);
  DB.raw.prepare(`INSERT INTO validations(id,project_id,candidate_id,validation_type,status,result_json,created_at,evidence_revision) VALUES('hv',?,?,'human_recompute','CONFIRM','{}',?,0)`).run(pid,cid,ts);
  const r=await refreshValidationMatrix({DB},pid);assert.equal(r.rows,1);
  const vm=await getValidationMatrix({DB},pid),x=vm.rows[0];
  assert.equal(vm.basis,'CURRENT_PROJECT_ONLY');assert.equal(vm.project_id,pid);assert.ok(vm.project_name);assert.ok(vm.generated_at);
  assert.equal(x.synthetic_status,'PASS');assert.equal(x.historical_status,'PASS');assert.equal(x.adversarial_status,'PASS');assert.equal(x.bis_status,'FAIL');assert.equal(x.ecb_status,'HOLD');assert.equal(x.human_status,'PASS');assert.equal(x.overall_status,'FAIL');
  assert.equal(vm.summary.dimensions.BIS.FAIL,1);assert.equal(vm.summary.dimensions.ECB.HOLD,1);
});

test('External Validation Matrix keeps unavailable external layers as N/A rather than failure',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0}),cid='cand_0',ts=now();
  DB.raw.prepare(`DELETE FROM simulation_runs WHERE project_id=? AND candidate_id=?`).run(pid,cid);
  DB.raw.prepare(`DELETE FROM validations WHERE project_id=? AND candidate_id=?`).run(pid,cid);
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('c',?,?, 'confirmation',1,100,?, ?,0)`).run(pid,cid,ev('FEASIBLE',{Synthetic:{classification:'FEASIBLE'}}),ts);
  await refreshValidationMatrix({DB},pid);const x=(await getValidationMatrix({DB},pid)).rows[0];
  assert.equal(x.synthetic_status,'PASS');assert.equal(x.bis_status,'NA');assert.equal(x.ecb_status,'NA');assert.equal(x.human_status,'NA');assert.equal(x.overall_status,'PARTIAL');
});

test('Figure 7 survival funnel uses strict cumulative PASS and exposes N/A layers safely', async()=>{
  const {buildFigures}=await import('../public/figures.js');
  const t={
    candidates:{cells:[],estimators:[],finalists:[]},reviewer:{by_confidence:[]},empirical:{panel:{n:0,episodes:[]}},
    project:{name:'Current Thesis Project',research_cycle:3,evidence_revision:7},generated_at:'2026-10-01T16:30:00.000Z',
    validation_matrix:{rows:[{candidate_id:'a'}]},
    survival_funnel:{basis:'CURRENT_PROJECT_ONLY',project_name:'Current Thesis Project',research_cycle:3,evidence_revision:7,generated_at:'2026-10-01T16:30:00.000Z',initial_candidates:4,final_survivors:1,final_rate:.25,stages:[
      {key:'baseline',stage:'Candidate pool',total:4,survivors:4,eliminated:0,pending:0,unavailable:false,survival_rate:1},
      {key:'synthetic',stage:'Synthetic',total:4,survivors:3,eliminated:1,pending:0,unavailable:false,survival_rate:.75},
      {key:'historical',stage:'Historical',total:3,survivors:2,eliminated:1,pending:0,unavailable:false,survival_rate:.5},
      {key:'adversarial',stage:'Adversarial',total:2,survivors:1,eliminated:1,pending:0,unavailable:false,survival_rate:.25},
      {key:'bis',stage:'BIS',total:1,survivors:1,eliminated:0,pending:1,unavailable:true,survival_rate:.25},
      {key:'ecb',stage:'ECB',total:1,survivors:1,eliminated:0,pending:0,unavailable:false,survival_rate:.25},
      {key:'human',stage:'Human',total:1,survivors:1,eliminated:0,pending:0,unavailable:false,survival_rate:.25}
    ]}
  };
  const figs=buildFigures(t),f=figs.find(x=>x.n===7);
  assert.ok(f);
  assert.match(f.svg,/Delegation Evidence Funnel/);
  assert.match(f.svg,/Final strict survivors: 1 \/ 4/);
  assert.match(f.svg,/Current Thesis Project · Cycle 3 · Evidence r7/);
  assert.match(f.svg,/actual current-project counts only/);
  assert.match(f.svg,/N\/A · gate unavailable/);
  assert.ok(!/undefined|NaN/.test(f.svg));
});

test('External Validation Matrix preserves last valid snapshot while a new evidence revision is revalidating',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0}),cid='cand_0',ts=now();
  DB.raw.prepare(`DELETE FROM simulation_runs WHERE project_id=? AND candidate_id=?`).run(pid,cid);
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('c_stale',?,?,'confirmation',1,100,?,?,0)`).run(pid,cid,ev('FEASIBLE',{Synthetic:{classification:'FEASIBLE'}}),ts);
  await refreshValidationMatrix({DB},pid);
  DB.raw.prepare(`UPDATE projects SET evidence_revision=1 WHERE id=?`).run(pid);
  const vm=await getValidationMatrix({DB},pid);
  assert.equal(vm.stale,true);
  assert.equal(vm.basis,'LAST_KNOWN_VALID_SNAPSHOT');
  assert.equal(vm.revision,0);
  assert.equal(vm.current_revision,1);
  assert.equal(vm.rows.length,1);
  assert.equal(vm.rows[0].synthetic_status,'PASS');
  assert.equal(vm.stale_reason,'CURRENT_REVISION_REVALIDATION_PENDING');
});


test('Figure 3 shows an explicit wait state and preserves tiny regret precision', async()=>{
  const {buildFigures}=await import('../public/figures.js');
  const base={reviewer:{by_confidence:[]},empirical:{panel:{n:0,episodes:[]}},validation_matrix:{rows:[]},survival_funnel:{stages:[]},project:{name:'p',research_cycle:1,evidence_revision:1}};
  let figs=buildFigures({...base,candidates:{cells:[],estimators:[],finalists:[{id:'a',estimator:'ema',sigma:.1,alpha:.35,K:2,d:0,max_regret:null}]}});
  let f=figs.find(x=>x.n===3);assert.ok(f);assert.match(f.svg,/Minimax Regret 계산 대기/);
  figs=buildFigures({...base,candidates:{cells:[],estimators:[],finalists:[{id:'a',estimator:'ema',sigma:.1,alpha:.35,K:2,d:0,max_regret:.00001234},{id:'b',estimator:'kalman',sigma:.2,alpha:.35,K:2,d:1,max_regret:.00004567}]}});
  f=figs.find(x=>x.n===3);assert.ok(f);assert.match(f.svg,/1\.23e-5|0\.000012/);assert.ok(!/>0<\/text>.*>0<\/text>.*>0<\/text>/.test(f.svg));
});


test('GET repairs empty Matrix from stored D1 simulation runs without a G3 event',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM candidate_validation_matrix; DELETE FROM simulation_runs;');
  const ts=new Date(Date.now()-1000).toISOString();
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('recovered_run',?, 'cand_0','confirmation',1,100,?, ?,0)`).run(pid,ev('FEASIBLE',{Synthetic:{classification:'FEASIBLE'}}),ts);
  const result=await getValidationMatrix({DB},pid);
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].synthetic_status,'PASS');
  assert.equal(result.summary.dimensions.Synthetic.PASS,1);
  assert.equal(DB.raw.prepare('SELECT count(*) n FROM candidate_validation_matrix').get().n,1);
});

test('GET refreshes Matrix after a later simulation run, without replacing true evidence with invented PASS',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec('DELETE FROM simulation_runs; DELETE FROM candidate_validation_matrix;');
  let v=await getValidationMatrix({DB},pid);
  assert.equal(v.rows.length,1);
  assert.equal(v.rows[0].synthetic_status,'NA');
  const ts=new Date(Date.now()+1000).toISOString();
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('new_run',?, 'cand_0','confirmation',1,100,?, ?,0)`).run(pid,ev('INFEASIBLE'),ts);
  v=await getValidationMatrix({DB},pid);
  assert.equal(v.rows[0].synthetic_status,'FAIL');
  assert.equal(v.rows[0].bis_status,'NA');
});


test('Matrix restores stress subset evidence when validation_groups are omitted',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0}),cid='cand_0',ts=now();
  DB.raw.prepare(`DELETE FROM simulation_runs WHERE project_id=? AND candidate_id=?`).run(pid,cid);
  DB.raw.prepare(`DELETE FROM validations WHERE project_id=? AND candidate_id=?`).run(pid,cid);
  const evidence=JSON.stringify({scenario_scores:{
    adversarial_delay:{classification:'FEASIBLE',loss_mean:0.1},
    official_bis_cpmi:{classification:'INFEASIBLE',loss_mean:9},
    official_ecb_resilience:{classification:'UNRESOLVED'}
  }});
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('stress_subset',?,?,'stress',1,3,?,?,0)`).run(pid,cid,evidence,ts);
  const vm=await getValidationMatrix({DB},pid),r=vm.rows[0];
  assert.equal(r.adversarial_status,'PASS');
  assert.equal(r.bis_status,'FAIL');
  assert.equal(r.ecb_status,'HOLD');
  assert.equal(r.historical_status,'NA');
  assert.equal(r.human_status,'NA');
});

test('Stress scenario metrics without valid constraints are HOLD not PASS',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:1,reviewer:0,episodes:0}),cid='cand_0',ts=now();
  DB.raw.prepare(`DELETE FROM simulation_runs WHERE project_id=? AND candidate_id=?`).run(pid,cid);
  DB.raw.prepare(`UPDATE project_config SET constraints_json='{}' WHERE project_id=?`).run(pid);
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('stress_metric',?,?,'stress',1,3,?,?,0)`).run(pid,cid,JSON.stringify({scenario_scores:{official_bis_sample:{loss_mean:0.001}}}),ts);
  const vm=await getValidationMatrix({DB},pid);
  assert.equal(vm.rows[0].bis_status,'HOLD');
});

test('per-candidate write-through refresh updates only the completed candidate and preserves peers',async()=>{
  const DB=makeDb(),pid=await seedProject(DB,{candidates:2,reviewer:0,episodes:0}),ts=now();
  DB.raw.prepare('DELETE FROM simulation_runs WHERE project_id=?').run(pid);
  await refreshValidationMatrix({DB},pid);
  DB.raw.prepare(`UPDATE candidate_validation_matrix SET synthetic_status='FAIL' WHERE candidate_id='cand_1'`).run();
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision)
    VALUES('fast_hist',?,'cand_0','historical',1,100,?,?,0)`).run(pid,ev('FEASIBLE',{Historical:{classification:'FEASIBLE'}}),ts);
  const result=await refreshValidationMatrix({DB},pid,{candidateId:'cand_0'});
  assert.equal(result.rows,1);
  const a=DB.raw.prepare('SELECT historical_status FROM candidate_validation_matrix WHERE candidate_id=?').get('cand_0');
  const b=DB.raw.prepare('SELECT synthetic_status FROM candidate_validation_matrix WHERE candidate_id=?').get('cand_1');
  assert.equal(a.historical_status,'PASS');
  assert.equal(b.synthetic_status,'FAIL');
});
