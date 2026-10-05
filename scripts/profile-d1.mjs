// D1 읽기 프로파일러: 실제 SQLite(node:sqlite) 위에서 파이프라인을 끝까지 돌리며
// (1) 쿼리 수, (2) 전체 테이블 스캔(SCAN) 플랜 수, (3) 스캔된 테이블 행 수 추정치를 집계한다.
// 주의: 'rows_read_estimate'는 D1 청구값과 동일하지 않은 추정치(스캔=테이블 전체 행수, 탐색=반환 행수)이다.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
// 결정적 UUID: 두 버전의 시뮬레이션 결과(시드가 candidate id 에 의존)를 1:1 비교하기 위함
let __c = 0; Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => `00000000-0000-4000-8000-${String(++__c).padStart(12, '0')}`, configurable: true });
const maxLoops = Number(process.argv[3] || 4000);
const imp = p => import(pathToFileURL(path.join(root, p)).href);

const db = new DatabaseSync(':memory:');
const mdir = path.join(root, 'migrations');
for (const f of fs.readdirSync(mdir).filter(x => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(mdir, f), 'utf8'));

const stats = { queries: 0, selects: 0, writes: 0, scans: 0, rows_read_estimate: 0 };
const bySql = new Map(), planCache = new Map(), sizeCache = { t: 0, m: new Map() };
let profiling = true;
const norm = s => s.replace(/\s+/g, ' ').trim().slice(0, 150);
function tableSize(t) { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 0; } }
function account(sql, resultRows, binds = []) {
  if (!profiling) return;
  stats.queries++;
  const key = norm(sql), rec = bySql.get(key) || { n: 0, rows: 0, scan: false };
  rec.n++;
  if (/^\s*select/i.test(sql)) {
    stats.selects++;
    let plan = planCache.get(sql);
    if (!plan) { try { plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(); } catch { plan = []; } planCache.set(sql, plan); }
    let est = 0, scanned = false;
    for (const p of plan) {
      const m = /^SCAN (?:TABLE )?(\w+)/.exec(p.detail);
      if (m && !/^SCAN \d|CONSTANT/.test(p.detail)) {
        scanned = true;
        const now = Date.now(); if (now - sizeCache.t > 1000) { sizeCache.t = now; sizeCache.m.clear(); }
        if (!sizeCache.m.has(m[1])) sizeCache.m.set(m[1], tableSize(m[1]));
        est += sizeCache.m.get(m[1]);
      }
    }
    if (!scanned) {
      est = Math.max(resultRows, 1); // 인덱스 탐색: 최소한 반환 행수만큼 읽는다고 추정
      // 집계(COUNT/SUM/GROUP BY)는 반환은 1행이어도 조건에 맞는 모든 인덱스 항목을 읽는다 → 같은 WHERE 로 개수를 센다.
      const m = /^\s*select[\s\S]*?\bfrom\s+(\w+)\s+where\s+([\s\S]*?)(\s+group by|\s+order by|\s+limit|$)/i.exec(sql);
      if (m && /count\(|sum\(|avg\(|group by/i.test(sql) && !/limit/i.test(sql.split(/where/i)[0]) ) {
        const before = sql.slice(0, sql.search(/\bfrom\b/i)), nPre = (before.match(/\?/g) || []).length, nWhere = (m[2].match(/\?/g) || []).length;
        if (nPre === 0) { try { const c = db.prepare(`SELECT COUNT(*) n FROM ${m[1]} WHERE ${m[2]}`).get(...binds.slice(0, nWhere)).n; est = Math.max(est, c); } catch {} }
      }
    }
    if (scanned) { stats.scans++; rec.scan = true; }
    stats.rows_read_estimate += est; rec.rows += est;
  }
  else stats.writes++;
  bySql.set(key, rec);
}
const stmt = (sql, binds = []) => ({
  bind: (...b) => stmt(sql, b),
  first: async () => { const r = db.prepare(sql).get(...binds) ?? null; account(sql, r ? 1 : 0, binds); return r; },
  all: async () => { const r = db.prepare(sql).all(...binds); account(sql, r.length, binds); return { results: r }; },
  run: async () => { const r = db.prepare(sql).run(...binds); account(sql, 0); return { meta: { changes: r.changes } }; },
  _run: () => { const r = db.prepare(sql).run(...binds); account(sql, 0); return r; }
});
const DB = { prepare: s => stmt(s), batch: async l => { db.exec('BEGIN'); try { const o = l.map(s => s._run()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
const env = { DB, MAX_JOBS_PER_TICK: '1', SIM_BATCH_SIZE: '180', AUTO_APPROVE: 'true', AUTO_PIPELINE: 'true' };


// ---- 시간 가속 + 큐 모킹: 실제 운영(Cron 15분 + Queue consumer)과 같은 방식으로 구동 ----
const realNow = Date.now.bind(Date); let offsetMs = 0;
class FakeDate extends Date { constructor(...a) { if (a.length === 0) super(realNow() + offsetMs); else super(...a); } static now() { return realNow() + offsetMs; } }
globalThis.Date = FakeDate;
// 큐 모델: 메시지는 (현재 가상시각 + delaySeconds)에 도착한다. 컨슈머는 도착한 메시지 1건당 processJobs 1회(max_batch_size=1).
// 이전 모델은 메시지 1건마다 가상 6초를 흘려 '지연 없이 보낸 메시지가 아직 due 가 아닌 job 을 놓치는' 문제를 가렸다.
const queue = [];
env.CDRS_QUEUE = {
  send: async (_b, o) => { queue.push(Date.now() + (o?.delaySeconds || 0) * 1000); },
  sendBatch: async (m, o) => { for (let i = 0; i < m.length; i++) queue.push(Date.now() + (o?.delaySeconds || 0) * 1000); }
};
const jumpTo = t => { if (t > Date.now()) offsetMs += t - Date.now(); };
const MSG_LATENCY_MS = 200;   // 메시지 1건 처리에 걸리는 실제 시간(가상)

const { processJobs, scheduleAll } = await imp('src/lib/orchestrator.js');
const { enqueue } = await imp('src/lib/db.js');
const { uid } = await imp('src/lib/util.js');
const withReviewer = !process.argv.includes('--no-reviewer');
const hasCounters = !!db.prepare(`SELECT 1 FROM pragma_table_info('projects') WHERE name='reviewer_obs_count'`).get();

const pid = uid('project'), nowIso0 = new Date().toISOString();
const design = { sigma: [0.03, 0.05, 0.10], tau: [0, 1, 2], alpha: [0.15, 0.35, 0.55, 0.75], K: [0, 1, 2, 3], d: [0, 1, 2, 4], W: [0.05, 0.12, 0.22], m: [0.08, 0.15, 0.25], estimators: ['ema', 'kalman', 'changepoint', 'adaptive'], max_candidates: 128 };
const constraints = { loss_max: 0.18, loss_exceed_max: 0.10, fp_max: 0.08, fn_max: 0.10, review_burden_max: 0.70, recovery_time_max: 4.0, confidence: 0.95 };
await DB.batch([
  DB.prepare(`INSERT INTO projects(id,name,description,status,current_stage,auto_run,auto_approve,created_at,updated_at) VALUES(?,?,?,'draft','define',1,1,?,?)`).bind(pid, 'profile', '', nowIso0, nowIso0),
  DB.prepare(`INSERT INTO project_config(project_id,research_question,design_json,constraints_json,benchmark_json,validation_json) VALUES(?,?,?,?,?,?)`).bind(pid, 'q', JSON.stringify(design), JSON.stringify(constraints), '{}', '{}')
]);
await enqueue(env, pid, 'seed_empirical_panel', {}, 5);
await enqueue(env, pid, 'define_project', {}, 10);
if (withReviewer) { // 검토자 표본 게이트(참가자 30명, 정답/오답 각 60건 이상) 통과용 관측치
  const mk = i => DB.prepare(`INSERT INTO reviewer_observations(id,project_id,participant_hash,ai_confidence,ai_correct,human_accept,response_ms,recovered,recovery_ms,context_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(`rv${i}`, pid, `p${i % 40}`, [.55, .75, .92][i % 3], i % 2, i % 4 ? 1 : 0, 900 + i * 7, i % 2, 1000 + i, '{}', nowIso0);
  await DB.batch([...Array.from({ length: 400 }, (_, i) => mk(i)), ...(hasCounters ? [DB.prepare(`UPDATE projects SET reviewer_obs_count=400 WHERE id=?`).bind(pid)] : [])]);   // 0008 이전 트리(비교용)에서도 동작
}
const jobCounts = {};
async function drain(until, cap = 5000) {
  // until(가상 epoch ms)까지 도착하는 메시지를 도착순으로 처리한다. 시간은 메시지 도착/처리에 따라서만 흐른다.
  let n = 0;
  while (queue.length && n++ < cap) {
    queue.sort((a, b) => a - b); const at = queue[0]; if (at > until) break; queue.shift();
    jumpTo(at); offsetMs += MSG_LATENCY_MS;
    const res = await processJobs(env); for (const r of res) jobCounts[r.type] = (jobCounts[r.type] || 0) + 1;
  }
}
const snap = () => ({ ...stats });
const diff = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, b[k] - a[k]]));
const stageNow = () => db.prepare(`SELECT current_stage s, status FROM projects WHERE id=?`).get(pid);
const hasReport = () => db.prepare(`SELECT COUNT(*) n FROM reports WHERE project_id=?`).get(pid).n > 0;

// Phase A: 파이프라인 가동(최대 12틱 = 3시간 상당, 메시지당 6초 가속). 완료(보고서 생성) 시 종료. 인간 검토 대기면 끝까지 대기 상태로 남는다.
const t0 = performance.now(); let ticks = 0; const T0 = Date.now(), TICK = 30 * 60_000;
await scheduleAll(env); await drain(T0 + TICK);
while (!hasReport() && ticks < 12) { ticks++; jumpTo(T0 + ticks * TICK); await scheduleAll(env); await drain(T0 + (ticks + 1) * TICK); }
const phaseA = snap(), stageA = stageNow(), secsA = ((performance.now() - t0) / 1000).toFixed(1);

const topA = [...bySql.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, 10);
// Phase B: 같은 상태에서 24시간 정상 운영(Cron 48회) 동안의 읽기량 = 일일 한도에 직접 영향
bySql.clear(); const b0 = snap();
const TB = Date.now(); for (let i = 1; i <= 48; i++) { jumpTo(TB + i * TICK); await scheduleAll(env); await drain(TB + (i + 1) * TICK); }
const phaseB = diff(b0, snap());
const topB = [...bySql.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, 8);

import crypto2 from 'node:crypto';
const eq = db.prepare(`SELECT c.sigma,c.tau,c.alpha,c.authority_k,c.delay_d,c.recovery_w,c.adjust_m,c.estimator,c.status cs,r.phase,r.n,r.loss_mean,r.loss_exceed_rate,r.fp_rate,r.fn_rate,r.review_burden,r.recovery_time,r.regret FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id ORDER BY c.sigma,c.tau,c.alpha,c.authority_k,c.delay_d,c.recovery_w,c.adjust_m,c.estimator,r.phase,r.n`).all();
const result_checksum = crypto2.createHash('sha256').update(JSON.stringify(eq)).digest('hex').slice(0, 16);

// ---- API 엔드포인트별 읽기량(대시보드를 열 때 호출되는 요청들) ----
let apiReport = null;
if (process.argv.includes('--api')) {
  const worker = (await imp('src/index.js')).default;
  const aenv = { ...env, ADMIN_TOKEN: 't', ASSETS: { fetch: async () => new Response('x') } };
  apiReport = {};
  for (const [name, url] of [['GET /api/projects', '/api/projects'], ['GET project detail', `/api/projects/${pid}`], ['GET candidates', `/api/projects/${pid}/candidates`], ['GET thesis', `/api/projects/${pid}/thesis`], ['GET report', `/api/projects/${pid}/report`], ['GET export candidates.csv', `/api/projects/${pid}/export/candidates.csv`]]) {
    bySql.clear(); const b = snap();
    const res = await worker.fetch(new Request('https://x' + url, { headers: { authorization: 'Bearer t' } }), aenv, { waitUntil() {} });
    await res.arrayBuffer();
    const d = diff(b, snap());
    apiReport[name] = { http: res.status, queries: d.queries, scans: d.scans, rows_read_estimate: d.rows_read_estimate, scan_queries: [...bySql.entries()].filter(([, v]) => v.scan).map(([k, v]) => `${v.rows}r ${k.slice(0, 90)}`) };
  }
}
const tbl = t => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 0; } };
console.log(JSON.stringify({
  root, mode: withReviewer ? 'with-reviewer-data' : 'waiting-for-human-review',
  phaseA_pipeline: { ticks, seconds: Number(secsA), stage: stageA, ...phaseA },
  phaseB_24h_steady_state: phaseB,
  result_checksum, result_rows: eq.length, api: apiReport,
  jobs_by_type: jobCounts,
  counters_vs_actual: !hasCounters ? null : db.prepare(`SELECT candidate_count, (SELECT COUNT(*) FROM design_candidates WHERE project_id=p.id) actual_candidates, reviewer_obs_count, (SELECT COUNT(*) FROM reviewer_observations WHERE project_id=p.id) actual_reviewer FROM projects p WHERE id=?`).get(pid),
  tables: Object.fromEntries(['design_candidates', 'simulation_runs', 'validations', 'jobs', 'audit_log'].map(t => [t, tbl(t)]))
}, null, 1));
console.log('\nPHASE B(24h 정상 운영) 상위 쿼리 - 추정 읽기 행수');
for (const [k, v] of topB) console.log(`${String(v.rows).padStart(9)} rows | ${String(v.n).padStart(5)}x | ${v.scan ? 'SCAN ' : 'index'} | ${k}`);
console.log('\nPHASE A(파이프라인 1회 완주) 상위 쿼리 - 추정 읽기 행수');
for (const [k, v] of topA) console.log(`${String(v.rows).padStart(9)} rows | ${String(v.n).padStart(5)}x | ${v.scan ? 'SCAN ' : 'index'} | ${k}`);
