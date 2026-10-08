import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';

test('0033 repairs materialized candidate counters and clamps negative drift',async()=>{
  const sql=fs.readFileSync('migrations/0033_cycle_stats_nonnegative_repair.sql','utf8');
  assert.match(sql,/DELETE FROM project_cycle_stats/);
  assert.match(sql,/candidate_pending=MAX\(0,candidate_pending/);
  assert.match(sql,/candidate_unresolved=MAX\(0,candidate_unresolved/);
});

test('project_cycle_stats never exposes a negative pending count after candidate updates',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:2,reviewer:0,episodes:0});
  const cycle=Number(DB.raw.prepare('SELECT research_cycle FROM projects WHERE id=?').get(id).research_cycle||1);
  const c=DB.raw.prepare("SELECT id FROM design_candidates WHERE project_id=? AND research_cycle=? LIMIT 1").get(id,cycle);
  // Simulate legacy drift, then perform an update that would previously subtract again.
  DB.raw.prepare('UPDATE project_cycle_stats SET candidate_pending=-8 WHERE project_id=? AND research_cycle=?').run(id,cycle);
  DB.raw.prepare("UPDATE design_candidates SET status='confirmed_feasible',updated_at=datetime('now') WHERE id=?").run(c.id);
  const s=DB.raw.prepare('SELECT candidate_pending FROM project_cycle_stats WHERE project_id=? AND research_cycle=?').get(id,cycle);
  assert.ok(Number(s.candidate_pending)>=0);
});
