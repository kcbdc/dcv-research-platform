import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThesisData, exportCsv, EXPORT_NAMES } from '../src/lib/thesis.js';
import { generateReport } from '../src/lib/report.js';
import { buildFigures } from '../public/figures.js';

// node:sqlite(Node ≥22.5)가 없으면 DB 통합 테스트는 건너뜁니다.
const hasSqlite = await import('node:sqlite').then(() => true, () => false), T = (name, fn) => test(name, { skip: !hasSqlite && 'node:sqlite unavailable' }, fn);
async function setup(opts) { const { makeDb } = await import('./helpers/d1shim.mjs'), { seedProject } = await import('./helpers/seed.mjs'); const DB = makeDb(), pid = await seedProject(DB, opts); return { env: { DB }, pid }; }

T('thesis data aggregates candidates, reviewer and panel', async () => {
  const { env, pid } = await setup(); const t = await buildThesisData(env, pid);
  assert.equal(t.candidates.total, 60);
  assert.equal(Object.values(t.candidates.by_class).reduce((a, b) => a + b, 0), 60);
  assert.equal(t.candidates.dims.estimator.length, 4);
  assert.equal(t.candidates.dims.sigma.reduce((a, e) => a + e.total, 0), 60);
  assert.ok(t.candidates.finalists.length > 0 && t.candidates.finalists.length <= 10);
  assert.ok(t.candidates.finalists[0].max_regret <= t.candidates.finalists.at(-1).max_regret);
  assert.equal(t.reviewer.n, 0); assert.equal(t.reviewer.participants, 0); assert.equal(t.reviewer.cumulative_trials,40); assert.equal(t.reviewer.cumulative_participants,4);
  assert.equal(t.empirical.panel.n, 30); assert.equal(t.empirical.panel.verified + t.empirical.panel.estimated, 30);
  assert.equal(t.simulation.phases.find(p => p.phase === 'exploration').decisions, 60 * 16200);
  assert.ok(t.selected && t.selected.by_phase.confirmation);
});

T('report contains all thesis sections, tables and figure references', async () => {
  const { env, pid } = await setup(); const r = await generateReport(env, pid), md = r.content_markdown;
  for (const h of ['## 0. 요약', '## 논문 사용 전 점검 사항', '## 1. 박사논문 연구모형 전체 설계', '## 2. 연구 질문과 설계', '## 3. 실증 보정 데이터', '## 4. 시뮬레이션 결과', '## 5. 강건성 검증', '## 6. 인간 검토자 보정', '## 7. 최종 판정', '## 8. 논의', '## 9. 한계 및 타당성 위협', '## 부록 B. 재현성 정보']) assert.ok(md.includes(h), h);
  for (const label of ['표 1.','표 2.','표 3.','표 4.','표 5.','표 6.','표 7.','표 8.','표 9.','표 9A.','표 9B.','표 9C.']) assert.ok(md.includes(`**${label}`), label);
  for (const n of [1,2,3,5,6,7]) assert.ok(md.includes(`![그림 ${n}.`), `figure ${n}`);
  assert.ok(md.length > 6000, `length ${md.length}`);
  assert.ok(!/undefined|NaN/.test(md), 'no undefined/NaN in report');
  const saved = await env.DB.prepare('SELECT COUNT(*) n FROM reports').first(); assert.equal(saved.n, 1);
});

T('report on an empty project does not crash or print undefined', async () => {
  const { env, pid } = await setup({ candidates: 0, reviewer: 0, episodes: 0 }); const r = await generateReport(env, pid);
  assert.ok(!/undefined|NaN/.test(r.content_markdown)); assert.ok(r.content_markdown.includes('검토자 관측이 없습니다'));
});

T('every figure is well-formed SVG with sensible size', async () => {
  const { env, pid } = await setup(); const figs = buildFigures(await buildThesisData(env, pid));
  assert.equal(figs.length, 10);
  for (const f of figs) { assert.ok(f.svg.startsWith('<svg') && f.svg.endsWith('</svg>'), f.file); assert.ok(!/undefined|NaN/.test(f.svg), `${f.file} has undefined/NaN`); assert.ok(f.width >= 600 && f.height >= 400); assert.equal((f.svg.match(/<svg/g) || []).length, 1); }
});

T('csv exports have BOM, header and one row per record', async () => {
  const { env, pid } = await setup();
  for (const n of EXPORT_NAMES) { const csv = await exportCsv(env, pid, n); assert.ok(csv.startsWith('\uFEFF'), n); }
  const c = (await exportCsv(env, pid, 'candidates')).trim().split('\r\n'); assert.equal(c.length, 61);
  assert.equal((await exportCsv(env, pid, 'reviewer_observations')).trim().split('\r\n').length, 41);
  assert.equal(await exportCsv(env, pid, 'nope'), null);
});
