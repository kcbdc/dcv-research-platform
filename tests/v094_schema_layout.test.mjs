import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('0028 rebuilds project_cycle_stats with candidate_active before backfill',()=>{
  const s=fs.readFileSync('migrations/0028_project_cycle_stats_schema_repair.sql','utf8');
  assert.match(s,/DROP TABLE IF EXISTS project_cycle_stats/);
  const create=s.indexOf('CREATE TABLE IF NOT EXISTS project_cycle_stats');
  const active=s.indexOf('candidate_active INTEGER',create);
  const insert=s.indexOf('INSERT INTO project_cycle_stats',create);
  assert.ok(create>=0&&active>create&&insert>active);
});

test('0027 guards partial project_cycle_stats schemas too',()=>{
  const s=fs.readFileSync('migrations/0027_d1_free_tier_read_guard.sql','utf8');
  assert.match(s,/v0\.9\.4 repair guard/);
  assert.ok(s.indexOf('DROP TABLE IF EXISTS project_cycle_stats') < s.indexOf('CREATE TABLE IF NOT EXISTS project_cycle_stats'));
});

test('v0.9.4 final responsive override collapses compute deck and contains canvas',()=>{
  const s=fs.readFileSync('public/style.css','utf8');
  const marker=s.lastIndexOf('v0.9.4 · hard responsive geometry recovery');
  assert.ok(marker>0);
  const tail=s.slice(marker);
  assert.match(tail,/@media \(max-width:1399\.98px\)/);
  assert.match(tail,/#computeSection\{[\s\S]*display:flex!important;[\s\S]*flex-direction:column!important/);
  assert.match(tail,/#regionCanvas\{[\s\S]*height:320px!important/);
});
