import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const human=fs.readFileSync(new URL('../src/lib/human_trials.js',import.meta.url),'utf8');
const migration=fs.readFileSync(new URL('../migrations/0032_query_roundtrip_and_human_session.sql',import.meta.url),'utf8');
const fn=index.slice(index.indexOf('async function humanStats('),index.indexOf('async function storageIntegrity('));

test('humanStats keeps normalized reviewer_trials source and skips publication aggregate on detail polling',()=>{
  assert.match(fn,/FROM reviewer_trials rt/);
  assert.match(fn,/COALESCE\(p\.reviewer_participant_count,0\) participants/);
  assert.doesNotMatch(fn,/json_extract\(context_json,'\$\.protocol'\)=\?/);
  assert.match(index,/humanStats\(env,projectId,cycle,humanProtocol,\{\},\{publication:false\}\)/);
});

test('humanStats exposes eligible_participants alias',()=>{
  assert.match(fn,/row\.eligible_participants=Number\(row\.protocol_participants\|\|0\)/);
});

test('report path batches project+definition reads and overlaps stored-report load with live stats',()=>{
  const rep=index.slice(index.indexOf("parts[3]==='report' && method==='GET'"));
  assert.match(rep,/env\.DB\.batch\(\[/);
  assert.match(rep,/Promise\.all\(\[loadReport\(\),humanStats\(/);
});

test('known research cycle avoids redundant project read during human-session verification',()=>{
  assert.match(human,/verifyHumanSession\(env,projectId,participant,token,knownCycle=null\)/);
  assert.match(human,/verifyHumanSession\(env,projectId,participant,sessionToken,Number\(p\.research_cycle\|\|1\)\)/);
  assert.match(human,/verifyHumanSession\(env,projectId,b\.participant_hash,sessionToken,Number\(t\.current_cycle\|\|t\.research_cycle\|\|1\)\)/);
});

test('migration covers participant DISTINCT hot path without JSON expression scans',()=>{
  assert.match(migration,/idx_reviewer_obs_project_participant/);
  assert.doesNotMatch(migration,/json_extract/);
});

test('project detail coalesces independent reads into D1 batches and overlaps derived gates',()=>{
  const detail=index.slice(index.indexOf("if(parts.length===3 && method==='GET')"),index.indexOf("if(parts[3]==='run' && method==='POST')"));
  assert.match(detail,/const \[pRes,defRes,measRes\]=await env\.DB\.batch/);
  assert.match(detail,/const \[appRes,staleRes,reviewerRes,jobsRes,scenarioRes\]=await env\.DB\.batch/);
  assert.match(detail,/Promise\.all\(\[\s*empiricalReadiness/);
});


test('human observation counters are trigger-owned so response batches do not issue redundant project updates',()=>{
  assert.match(migration,/reviewer_participant_count/);
  assert.match(migration,/CREATE TRIGGER trg_projects_reviewer_last_observed/);
  const record=human.slice(human.indexOf('export async function recordHumanTrial'),human.indexOf('export const __test'));
  assert.doesNotMatch(record,/UPDATE projects SET reviewer_obs_count/);
});
