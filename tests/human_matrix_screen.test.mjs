import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { seedProject } from './helpers/seed.mjs';
import { refreshValidationMatrix, getValidationMatrix, withNoninferiority, MATRIX_RULES_VERSION } from '../src/lib/validation_matrix.js';
import { finalizeRecompute, enqueueRecompute } from '../src/lib/recompute.js';

const now=()=>new Date().toISOString();
const ev=(classification,groups={},extra={})=>JSON.stringify({classification,validation_groups:groups,...extra});

async function fresh(candidates=1){
  const DB=makeDb(),pid=await seedProject(DB,{candidates,reviewer:0,episodes:0});
  DB.raw.exec(`DELETE FROM simulation_runs; DELETE FROM validations; DELETE FROM candidate_validation_matrix; DELETE FROM approvals;`);
  return {DB,pid};
}
const conf=(DB,pid,cid,cls,extra={})=>DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,'confirmation',1,100,?,?,0)`).run('c_'+cid,pid,cid,ev(cls,{Synthetic:{classification:cls}},extra),now());
const human=(DB,pid,cid,type,status,t=now())=>DB.raw.prepare(`INSERT INTO validations(id,project_id,candidate_id,validation_type,status,result_json,created_at,evidence_revision) VALUES(?,?,?,?,?,'{}',?,0)`).run('v_'+type+'_'+cid+'_'+Math.random(),pid,cid,type,status,t);

test('Human is HOLD (not NA) for a Synthetic-passing candidate with no human verdict, with a reason',async()=>{
  const {DB,pid}=await fresh();
  conf(DB,pid,'cand_0','FEASIBLE');
  let x=(await getValidationMatrix({DB},pid)).rows[0];
  assert.equal(x.human_status,'HOLD');assert.equal(x.overall_status,'HOLD');
  assert.equal(x.detail.human.reason,'HUMAN_REVIEWER_MODEL_PENDING');
  DB.raw.prepare(`INSERT INTO reviewer_models(id,project_id,version,model_json,created_at,research_cycle,evidence_revision) VALUES('rm',?,1,'{}',?,1,0)`).run(pid,now());
  await refreshValidationMatrix({DB},pid);
  x=(await getValidationMatrix({DB},pid)).rows[0];
  assert.equal(x.human_status,'HOLD');assert.equal(x.detail.human.reason,'HUMAN_RECOMPUTE_PENDING');
});

test('Human stays NA when the candidate never passed Synthetic confirmation',async()=>{
  const {DB,pid}=await fresh();
  conf(DB,pid,'cand_0','INFEASIBLE');
  const x=(await getValidationMatrix({DB},pid)).rows[0];
  assert.equal(x.synthetic_status,'FAIL');assert.equal(x.human_status,'NA');assert.equal(x.overall_status,'FAIL');
});

test('human_screen verdicts map to PASS/HOLD/FAIL and human_recompute takes precedence',async()=>{
  const {DB,pid}=await fresh(4);
  for(const id of ['cand_0','cand_1','cand_2','cand_3'])conf(DB,pid,id,'FEASIBLE');
  human(DB,pid,'cand_0','human_screen','CONFIRM');
  human(DB,pid,'cand_1','human_screen','HOLD');
  human(DB,pid,'cand_2','human_screen','REJECT');
  human(DB,pid,'cand_3','human_screen','REJECT',new Date(Date.now()-5000).toISOString());
  human(DB,pid,'cand_3','human_recompute','CONFIRM',new Date(Date.now()-9000).toISOString());   // older but authoritative
  const by=Object.fromEntries((await getValidationMatrix({DB},pid)).rows.map(r=>[r.candidate_id,r]));
  assert.equal(by.cand_0.human_status,'PASS');assert.equal(by.cand_1.human_status,'HOLD');assert.equal(by.cand_2.human_status,'FAIL');
  assert.equal(by.cand_3.human_status,'PASS');assert.equal(by.cand_3.detail.human.source,'human_recompute');
  assert.equal(by.cand_2.overall_status,'FAIL');
});

test('Matrix rows cached by an older rule set are rebuilt once (Human N/A -> HOLD)',async()=>{
  const {DB,pid}=await fresh();
  conf(DB,pid,'cand_0','FEASIBLE');
  await refreshValidationMatrix({DB},pid);
  DB.raw.prepare(`UPDATE candidate_validation_matrix SET human_status='NA',overall_status='PARTIAL',detail_json='{}'`).run();
  const x=(await getValidationMatrix({DB},pid)).rows[0];
  assert.equal(x.human_status,'HOLD');
  assert.equal(x.detail.rules_version,MATRIX_RULES_VERSION);
});

test('non-inferiority is not ignored by group statuses',async()=>{
  assert.equal(withNoninferiority('PASS',{},{exact:true}),'PASS');
  const failing={noninferiority:{comparisons:[{lo:.02,hi:.05,limit:0}]}},unresolved={noninferiority:{comparisons:[{lo:-.02,hi:.05,limit:0}]}},ok={noninferiority:{comparisons:[{lo:-.05,hi:-.01,limit:0}]}};
  assert.equal(withNoninferiority('PASS',failing,{exact:true}),'FAIL');
  assert.equal(withNoninferiority('HOLD',failing,{exact:true}),'FAIL');
  assert.equal(withNoninferiority('PASS',unresolved,{exact:true}),'HOLD');
  assert.equal(withNoninferiority('PASS',ok,{exact:true}),'PASS');
  // pooled stress contrast cannot be attributed to one subset: it may block a PASS, but never creates a FAIL
  assert.equal(withNoninferiority('PASS',failing,{exact:false}),'HOLD');
  assert.equal(withNoninferiority('FAIL',ok,{exact:false}),'FAIL');
  assert.equal(withNoninferiority('NA',failing,{exact:true}),'NA');
  const {DB,pid}=await fresh();
  conf(DB,pid,'cand_0','INFEASIBLE',{noninferiority:{comparisons:[{lo:.02,hi:.05,limit:0}]}});
  DB.raw.prepare(`UPDATE simulation_runs SET result_json=? WHERE id='c_cand_0'`).run(ev('INFEASIBLE',{Synthetic:{classification:'FEASIBLE'}},{noninferiority:{comparisons:[{lo:.02,hi:.05,limit:0}]}}));
  DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('s',?,'cand_0','stress',1,100,?,?,0)`).run(pid,ev('INFEASIBLE',{Adversarial:{classification:'FEASIBLE'}},{noninferiority:{comparisons:[{lo:.02,hi:.05,limit:0}]}}),now());
  const x=(await getValidationMatrix({DB},pid)).rows[0];
  assert.equal(x.synthetic_status,'FAIL');       // group said FEASIBLE, pooled non-inferiority failed
  assert.equal(x.adversarial_status,'HOLD');
});

test('recompute covers every confirmed_feasible candidate; only robust-confirmed ones get human_recompute',async()=>{
  const {DB,pid}=await fresh(3);
  DB.raw.exec(`UPDATE design_candidates SET status='confirmed_feasible' WHERE id IN ('cand_0','cand_1'); UPDATE design_candidates SET status='infeasible' WHERE id='cand_2';`);
  const ts=now();
  DB.raw.prepare(`INSERT INTO validations(id,project_id,candidate_id,validation_type,status,result_json,created_at,evidence_revision) VALUES('rb',?,'cand_0','robust','CONFIRM','{}',?,0)`).run(pid,ts);
  const q=await enqueueRecompute({DB},pid);
  assert.equal(q.queued,2);
  const jobs=DB.raw.prepare(`SELECT payload_json FROM jobs WHERE type='compute_candidate' AND phase='recompute'`).all().map(j=>JSON.parse(j.payload_json).candidate_id).sort();
  assert.deepEqual(jobs,['cand_0','cand_1']);
  const run=(id,cid,cls)=>DB.raw.prepare(`INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES(?,?,?,'recompute',1,100,?,?,0)`).run(id,pid,cid,JSON.stringify({classification:cls,metrics:{loss_mean:.1}}),ts);
  run('r0','cand_0','FEASIBLE');run('r1','cand_1','INFEASIBLE');
  const res=await finalizeRecompute({DB},pid);
  assert.equal(res.confirmed,1);assert.equal(res.screened,1);assert.equal(res.total,2);
  const rows=DB.raw.prepare(`SELECT candidate_id,validation_type,status FROM validations WHERE validation_type IN ('human_recompute','human_screen') ORDER BY candidate_id`).all();
  assert.deepEqual(rows.map(r=>[r.candidate_id,r.validation_type,r.status]),[['cand_0','human_recompute','CONFIRM'],['cand_1','human_screen','REJECT']]);
  // approval selects only human_recompute CONFIRM: the screen-only candidate can never be approved
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM validations WHERE candidate_id='cand_1' AND validation_type='human_recompute'`).get().n,0);
  // idempotent: a second finalize writes nothing new
  await finalizeRecompute({DB},pid);
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM validations WHERE validation_type IN ('human_recompute','human_screen')`).get().n,2);
  // matrix reflects both
  const by=Object.fromEntries((await getValidationMatrix({DB},pid)).rows.map(r=>[r.candidate_id,r]));
  assert.equal(by.cand_1.human_status,'FAIL');
});
