import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrationArtifacts} from '../scripts/reconcile-d1-migrations.mjs';

test('migration reconciler recognizes non-idempotent 0004 schema artifacts',()=>{
 const sql=fs.readFileSync(new URL('../migrations/0004_cdrs_engine.sql',import.meta.url),'utf8');
 const a=migrationArtifacts(sql);
 assert.ok(a.columns.some(x=>x.table==='design_candidates'&&x.column==='estimator'));
 assert.ok(a.columns.some(x=>x.column==='evidence_status'));
 assert.ok(a.tables.includes('candidate_evidence'));
 assert.ok(a.indexes.includes('idx_evidence_candidate_phase'));
});

test('workflow reconciles legacy ledger before wrangler migration apply',()=>{
 const y=fs.readFileSync(new URL('../.github/workflows/dcv-research.yml',import.meta.url),'utf8');
 const reconcile=y.indexOf('Reconcile legacy D1 migration ledger');
 const apply=y.indexOf('Apply pending D1 migrations');
 assert.ok(reconcile>=0 && apply>reconcile);
 assert.match(y,/node scripts\/reconcile-d1-migrations\.mjs/);
});
