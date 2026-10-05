import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {buildThesisData} from '../src/lib/thesis.js';
import {approvalGates} from '../src/lib/evidence.js';

const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const reviewerSrc=read('../src/lib/reviewer.js');
const humanSrc=read('../src/lib/human_trials.js');
const thesisSrc=read('../src/lib/thesis.js');
const orchSrc=read('../src/lib/orchestrator.js');
const migration=read('../migrations/0031_query_hotpath_compaction.sql');

test('v0.10.7 normalized human queries avoid context-json scans on the current protocol hot path',()=>{
  assert.match(reviewerSrc,/JOIN reviewer_trials rt ON rt\.id=o\.trial_id/);
  assert.match(reviewerSrc,/rt\.research_cycle=\?/);
  assert.doesNotMatch(reviewerSrc,/SELECT \* FROM reviewer_observations WHERE project_id=\? AND json_extract/);
  assert.match(thesisSrc,/WITH participant_state AS/);
  assert.match(thesisSrc,/LEFT JOIN reviewer_trials rt ON rt\.id=o\.trial_id/);
  assert.doesNotMatch(thesisSrc,/SELECT COUNT\(\*\) FROM reviewer_trials rt WHERE rt\.project_id=o\.project_id/);
});

test('human QC uses same-cycle main trials for fast-share and one compact aggregate',()=>{
  assert.match(humanSrc,/rt\.research_cycle=\?/);
  assert.match(humanSrc,/fast_main/);
  assert.match(humanSrc,/trial_phase='main' AND response_ms<\?/);
  assert.doesNotMatch(humanSrc,/json_extract\(o\.context_json,'\$\.quality\.too_fast'\)/);
});

test('reviewer wait uses denormalized last-observation marker instead of polling observations',()=>{
  assert.match(migration,/reviewer_last_observed_at/);
  assert.match(orchSrc,/p\.reviewer_last_observed_at/);
  assert.doesNotMatch(orchSrc,/SELECT created_at FROM reviewer_observations WHERE project_id=\?/);
});

test('approval gates are returned correctly from a single compact statement',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0});
  let calls=0; const wrapped={...DB,prepare(sql){calls++;return DB.prepare(sql);}};
  const g=await approvalGates({DB:wrapped},id);
  assert.equal(g.total,6); assert.equal(calls,1);
});

test('legacy explicit protocol stays distinct while normalized current-cycle report remains buildable',async()=>{
  const DB=makeDb(),id=await seedProject(DB,{reviewer:3,candidates:0,episodes:0});
  DB.raw.prepare("UPDATE reviewer_observations SET context_json=json_object('protocol','older-explicit-protocol') WHERE rowid=(SELECT rowid FROM reviewer_observations LIMIT 1)").run();
  const t=await buildThesisData({DB},id);
  assert.equal(t.reviewer.cumulative_trials,3);
  assert.equal(t.reviewer.legacy_untagged_trials,2);
});
