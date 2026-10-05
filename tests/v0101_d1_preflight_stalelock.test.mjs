import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('actions preflight requires project_cycle_stats and workflow applies migrations first',()=>{
  const diag=fs.readFileSync('scripts/lib/runner-diagnostics.mjs','utf8');
  const wf=fs.readFileSync('.github/workflows/dcv-research.yml','utf8');
  assert.match(diag,/project_cycle_stats/);
  assert.match(diag,/MIGRATION_0027_MISSING/);
  assert.match(wf,/Apply pending D1 migrations/);
  assert.match(wf,/wrangler@4\.41\.0 d1 migrations apply DB --remote/);
  assert.ok(wf.indexOf('Apply pending D1 migrations') < wf.indexOf('Compute and resume research jobs'));
});

test('stale locks are stored as stable code and rendered as recovery notice',()=>{
  const db=fs.readFileSync('src/lib/db.js','utf8');
  const app=fs.readFileSync('public/app.js','utf8');
  assert.match(db,/last_error='stale_lock_recovered'/);
  assert.doesNotMatch(db,/termination cause unverified/);
  assert.match(app,/이전 실행이 비정상 종료되어 작업 잠금을 자동 복구했습니다/);
});
