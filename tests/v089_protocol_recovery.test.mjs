import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {ensureFrozenProtocol,assertProtocolIntegrity,PROTOCOL_SCHEMA,ENGINE_VERSION} from '../src/lib/rigor.js';
import {processJobs,advanceProject} from '../src/lib/orchestrator.js';
import {nowIso} from '../src/lib/util.js';

function envFor(DB){return {DB,COMPUTE_EXECUTOR:'github-actions',EXTERNAL_RUNTIME:'github-actions',MAX_JOBS_PER_TICK:1};}

test('current frozen protocols declare the executable runtime contract',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
  const p=await ensureFrozenProtocol({DB},id);
  assert.equal(p.protocol.schema,PROTOCOL_SCHEMA);
  assert.equal(p.protocol.engine_version,ENGINE_VERSION);
  assert.ok(p.protocol.execution_config?.constraints);
  assert.ok(p.protocol.execution_config?.validation);
});

test('legacy frozen runtime is classified as upgrade-required before compute',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
  const p=await ensureFrozenProtocol({DB},id);
  const legacy={...p.protocol,schema:'DCV-PROTOCOL-1.2',engine_version:'DCV-CDRS-v3'};
  DB.raw.prepare('UPDATE research_protocols SET protocol_json=? WHERE id=?').run(JSON.stringify(legacy),p.id);
  await assert.rejects(assertProtocolIntegrity({DB},id),/protocol_runtime_upgrade_required/);
});

test('failed compute under a legacy protocol starts one fresh cycle instead of retrying forever',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec("DELETE FROM jobs; DELETE FROM simulation_runs; UPDATE projects SET status='running', auto_run=1; UPDATE design_candidates SET status='pending';");
  const p=await ensureFrozenProtocol({DB},id);
  const legacy={...p.protocol,schema:'DCV-PROTOCOL-1.2',engine_version:'DCV-CDRS-v3'};
  DB.raw.prepare('UPDATE research_protocols SET protocol_json=? WHERE id=?').run(JSON.stringify(legacy),p.id);
  const ts=nowIso();
  DB.raw.prepare("INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at) VALUES('legacy_compute',?, 'compute_candidate','queued',40,?,'exploration',?,?,?)")
    .run(id,JSON.stringify({candidate_id:'cand_0',phase:'exploration',cycle:0}),ts,ts,ts);
  const result=await processJobs(envFor(DB));
  assert.equal(result.length,1); assert.equal(result[0].ok,true); assert.equal(result[0].recovered,true);
  const proj=DB.raw.prepare('SELECT research_cycle,evidence_revision FROM projects WHERE id=?').get(id);
  assert.equal(proj.research_cycle,2);
  assert.ok(proj.evidence_revision>=1);
  assert.equal(DB.raw.prepare("SELECT status FROM jobs WHERE id='legacy_compute'").get().status,'failed');
  assert.ok(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=? AND type='define_project' AND status='queued'").get(id).n>=1);
});

test('advance_project repairs already-stranded UNEVALUATED candidates with protocol mismatch failures',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
  DB.raw.exec("DELETE FROM jobs; UPDATE projects SET status='running', auto_run=1; UPDATE design_candidates SET status='pending';");
  const ts=nowIso();
  DB.raw.prepare("INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at,last_error) VALUES('poison',?,'compute_candidate','failed',40,?,'exploration',?,?,?,'Error: protocol_integrity_failure')")
    .run(id,JSON.stringify({candidate_id:'cand_0',phase:'exploration',cycle:0}),ts,ts,ts);
  const out=await advanceProject(envFor(DB),id);
  assert.equal(out.stage,'protocol_recovery');
  assert.equal(DB.raw.prepare('SELECT research_cycle FROM projects WHERE id=?').get(id).research_cycle,2);
});
