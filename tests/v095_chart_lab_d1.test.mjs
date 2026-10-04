import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
const labEvidence=fs.readFileSync(new URL('../src/lib/lab_evidence.js',import.meta.url),'utf8');
const lab=fs.readFileSync(new URL('../src/lib/lab.js',import.meta.url),'utf8');
const labUi=fs.readFileSync(new URL('../public/lab.js',import.meta.url),'utf8');
const mig=fs.readFileSync(new URL('../migrations/0029_lab_d1_read_guard.sql',import.meta.url),'utf8');

test('region chart reserves a real bottom safe area for x-axis labels',()=>{
  assert.match(app,/b:66/);
  assert.match(app,/정보오차 →',p\.l\+cw\/2-35,H-22/);
  assert.match(css,/v0\.9\.5 · chart safe-area/);
  assert.match(css,/#regionCanvas\{height:318px!important/);
});

test('research lab snapshot uses materialized cycle stats and bounded evidence samples',()=>{
  assert.match(labEvidence,/DCV-LAB-EVIDENCE-4/);
  assert.match(labEvidence,/LEFT JOIN project_cycle_stats/);
  assert.match(labEvidence,/LIMIT 40/);
  assert.match(labEvidence,/LIMIT 240/);
  assert.doesNotMatch(labEvidence,/p\.updated_at\]\.join/);
  assert.match(labEvidence,/WITH done AS/);
});

test('lab polling can return 304 after one cheap campaign probe and does not reload review every render',()=>{
  assert.match(lab,/Cheap ETag probe first/);
  assert.match(lab,/getLabStatus\(env,projectId,probe\)/);
  assert.match(labUi,/120000/);
  assert.match(labUi,/showDesk\(selectedRole,false\)/);
  assert.match(labUi,/showDesk\(b\.dataset\.role,true\)/);
});

test('lab hot paths have dedicated D1 indexes',()=>{
  for(const name of ['idx_runs_project_created_candidate','idx_candidates_project_cycle_status_regret','idx_lab_tasks_campaign_status_seq','idx_lab_tasks_campaign_role_status_seq']) assert.match(mig,new RegExp(name));
});
