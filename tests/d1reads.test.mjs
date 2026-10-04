import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/d1shim.mjs';
import { enqueue, enqueueOnce, claimJobs, finishJob, wakeDueJobs } from '../src/lib/db.js';
import { seedProject } from './helpers/seed.mjs';
import { buildThesisData } from '../src/lib/thesis.js';
import worker from '../src/index.js';
import { advanceProject, scheduleAll } from '../src/lib/orchestrator.js';
import { cached, bust } from '../src/lib/memo.js';

const now = () => new Date().toISOString();
async function project(db, id = 'p1', status = 'draft') {
  await db.prepare(`INSERT INTO projects(id,name,description,status,current_stage,auto_run,auto_approve,created_at,updated_at) VALUES(?,?,?,?,?,1,1,?,?)`).bind(id, 'n', '', status, 'define', now(), now()).run();
}
const plan = (db, sql, ...b) => db.raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...b).map(r => r.detail).join(' | ');

test('enqueueOnce coalesces queued duplicates (advance_project storm)', async () => {
  const db = makeDb(), env = { DB: db }; await project(db);
  const a = await enqueueOnce(env, 'p1', 'advance_project', {}, 98, 5);
  const b = await enqueueOnce(env, 'p1', 'advance_project', {}, 98, 5);
  assert.ok(a); assert.equal(b, null);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='advance_project'`).get().n, 1);
});

test('enqueue records the phase column used by the jobs index', async () => {
  const db = makeDb(), env = { DB: db }; await project(db);
  await enqueue(env, 'p1', 'compute_candidate', { candidate_id: 'c', phase: 'stress', cycle: 0 }, 50);
  assert.equal(db.raw.prepare(`SELECT phase FROM jobs`).get().phase, 'stress');
});

test('finished projects cost zero reads: advance returns early and cron skips them', async () => {
  const db = makeDb(), env = { DB: db }; await project(db, 'done1', 'report_ready'); await project(db, 'live1', 'draft');
  assert.deepEqual(await advanceProject(env, 'done1'), { stage: 'complete' });
  await scheduleAll(env);
  const queued = db.raw.prepare(`SELECT project_id FROM jobs WHERE type='advance_project'`).all().map(r => r.project_id);
  assert.deepEqual(queued, ['live1']);
});

test('reviewer wait does not poll: a HOLD marker with no new observations stops re-queuing fit_reviewer', async () => {
  const db = makeDb(), env = { DB: db }; await project(db);
  db.raw.prepare(`UPDATE projects SET reviewer_hold_marker='' WHERE id='p1'`).run();
  const r = await advanceProject(env, 'p1');
  assert.equal(r.stage, 'human_review'); assert.equal(r.waiting, 'no_new_reviewer_observations');
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='fit_reviewer'`).get().n, 0);
  // 새 관측이 들어오면 마커와 달라져 다시 진행 가능(앞 단계 조건이 없는 이 최소 프로젝트에서는 define 단계로 판정되지만, 대기 분기는 탈출한다)
  await db.prepare(`INSERT INTO reviewer_observations(id,project_id,participant_hash,ai_confidence,ai_correct,human_accept,response_ms,created_at) VALUES('o1','p1','a',0.5,1,1,10,?)`).bind(now()).run();
  const r2 = await advanceProject(env, 'p1'); assert.notEqual(r2.waiting, 'no_new_reviewer_observations');
});

test('claimJobs reads in priority order using idx_jobs_claim (no temp sort over the whole queue)', async () => {
  const db = makeDb(); await project(db);
  const p = plan(db, `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY priority ASC, created_at ASC LIMIT ?`, 'x', 1);
  assert.match(p, /idx_jobs_claim/); assert.doesNotMatch(p, /TEMP B-TREE/);
  const env = { DB: db }; await enqueue(env, 'p1', 'x', {}, 90); await enqueue(env, 'p1', 'y', {}, 10);
  assert.equal((await claimJobs(env, 1))[0].type, 'y');
});

test('hot queries are index lookups, not full table scans (regression guard)', () => {
  const db = makeDb();
  const hot = [
    [`SELECT phase,COUNT(DISTINCT candidate_id) n FROM simulation_runs WHERE project_id=? AND phase IN ('historical','stress','recompute') GROUP BY phase`, 'p'],
    [`SELECT validation_type t,status s,COUNT(*) c,COUNT(DISTINCT candidate_id) d FROM validations WHERE project_id=? AND validation_type IN ('robust','human_recompute') GROUP BY validation_type,status`, 'p'],
    [`SELECT c.*, (SELECT status FROM validations v WHERE v.candidate_id=c.id AND v.validation_type='human_recompute' ORDER BY created_at DESC LIMIT 1) final_status FROM design_candidates c WHERE project_id=? ORDER BY sigma,authority_k,delay_d LIMIT 500`, 'p'],
    [`SELECT type,status,attempts,last_error,created_at,updated_at FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 20`, 'p'],
    [`SELECT 1 x FROM jobs WHERE project_id=? AND type=? AND status IN ('queued','running') AND phase=? LIMIT 1`, 'p', 't', 'x'],
    [`SELECT metrics_json FROM measurements WHERE project_id=? ORDER BY measured_at DESC LIMIT 1`, 'p'],
    [`SELECT id FROM approvals WHERE project_id=? ORDER BY created_at DESC LIMIT 1`, 'p'],
    [`SELECT id FROM reports WHERE project_id=? ORDER BY created_at DESC LIMIT 1`, 'p'],
    [`SELECT key,value_num,observed_at FROM raw_observations WHERE project_id=? AND value_num IS NOT NULL ORDER BY observed_at DESC LIMIT 5000`, 'p'],
    [`SELECT created_at FROM reviewer_observations WHERE project_id=? ORDER BY created_at DESC LIMIT 1`, 'p'],
  ];
  for (const [sql, ...b] of hot) { const p = plan(db, sql, ...b); assert.doesNotMatch(p, /\bSCAN (TABLE )?(simulation_runs|validations|jobs|measurements|approvals|reports|raw_observations|reviewer_observations)\b/, p + ' <= ' + sql); }
});

test('memo is per-DB, expires, and is busted on writes', async () => {
  const a = { DB: {} }, b = { DB: {} }; let n = 0; const load = async () => ++n;
  assert.equal(await cached(a, 'p', 'k', load), 1); assert.equal(await cached(a, 'p', 'k', load), 1);
  assert.equal(await cached(b, 'p', 'k', load), 2, 'different DB binding must not share cache');
  bust(a, 'p'); assert.equal(await cached(a, 'p', 'k', load), 3);
  assert.equal(await cached(a, 'p', 'k2', load, -1), 4); assert.equal(await cached(a, 'p', 'k2', load, -1), 5, 'ttl<=0 never hits');
});

// ---------------------------------------------------------------- v0.5.2
const fakeQueue = () => { const sent = []; return { sent, send: async (body, opts) => { sent.push({ body, delay: opts?.delaySeconds }); }, sendBatch: async (msgs, opts) => { for (const m of msgs) sent.push({ body: m.body, delay: opts?.delaySeconds }); } }; };

test('queue message is delayed exactly like run_after (no early wake-up that leaves the job stranded)', async () => {
  const db = makeDb(), q = fakeQueue(), env = { DB: db, CDRS_QUEUE: q }; await project(db);
  await enqueue(env, 'p1', 'advance_project', {}, 98, 5);
  await enqueue(env, 'p1', 'x', {}, 10);
  assert.equal(q.sent[0].delay, 5); assert.equal(q.sent[1].delay, undefined);
  // 큰 지연도 Queues 상한(12h) 안으로 제한
  await enqueue(env, 'p1', 'y', {}, 10, 10 * 86400); assert.equal(q.sent[2].delay, 43200);
});

test('a failed job that will be retried gets a wake-up message at its backoff time', async () => {
  const db = makeDb(), q = fakeQueue(), env = { DB: db, CDRS_QUEUE: q }; await project(db);
  await enqueue(env, 'p1', 'x', {}, 10); q.sent.length = 0;
  const [job] = await claimJobs(env, 1);
  await finishJob(env, job, new Error('boom'));
  assert.equal(q.sent.length, 1); assert.equal(q.sent[0].body.job_id, job.id); assert.equal(q.sent[0].delay, 60);   // 30*2^1
  const row = db.raw.prepare(`SELECT status FROM jobs WHERE id=?`).get(job.id); assert.equal(row.status, 'queued');
});

test('cron wakes stranded due jobs (queued, due, but no message) and leaves not-yet-due jobs alone', async () => {
  const db = makeDb(), q = fakeQueue(), env = { DB: db, CDRS_QUEUE: q }; await project(db);
  const t = (ms) => new Date(Date.now() + ms).toISOString();
  const ins = (id, runAfter) => db.raw.prepare(`INSERT INTO jobs(id,project_id,type,status,priority,payload_json,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, 'p1', 'advance_project', 'queued', 98, '{}', runAfter, now(), now());
  ins('due1', t(-60000)); ins('later', t(3600000));
  assert.equal(await wakeDueJobs(env), 1);
  assert.deepEqual(q.sent.map(m => m.body.job_id), ['due1']);
  // scheduleAll 이 큐 전송 방식에서도 같은 안전망을 쓴다
  q.sent.length = 0; const r = await scheduleAll(env);
  assert.equal(r.transport, 'cloudflare-queue'); assert.ok(q.sent.some(m => m.body.job_id === 'due1'));
  // 큐가 없으면(D1 fallback) 아무것도 보내지 않는다
  assert.equal(await wakeDueJobs({ DB: db }), 0);
  // 읽기 상한: 방치 job 이 아무리 많아도 Cron 1회에 limit 행까지만 읽는다
  for (let i = 0; i < 40; i++) ins('s' + i, t(-1000));
  assert.equal(await wakeDueJobs(env, 10), 10);
  assert.match(plan(db, `SELECT id,project_id,type FROM jobs WHERE status='queued' AND run_after<=? ORDER BY priority ASC, created_at ASC LIMIT ?`, 'x', 10), /idx_jobs_claim/);
});

test('buildThesisData scans simulation_runs and reviewer_observations once each (no duplicate aggregates)', async () => {
  const db = makeDb(); const pid = await seedProject(db, { candidates: 30, reviewer: 50, episodes: 10 });
  const log = []; const wrapped = { ...db, prepare: sql => { log.push(sql); return db.prepare(sql); } };
  await buildThesisData({ DB: wrapped }, pid);
  const n = re => log.filter(q => re.test(q)).length;
  assert.equal(n(/FROM reviewer_observations/i), 1);
  assert.ok(n(/FROM simulation_runs/i) <= 2, 'one full read + at most the selected-candidate evidence lookup');
  assert.equal(n(/GROUP BY phase/i), 0);
});

test('reviewer observation counter: POST increments it atomically and project detail reads it without a COUNT scan', async () => {
  const db = makeDb(), env = { DB: db, ADMIN_TOKEN: 't', ASSETS: { fetch: async () => new Response('x') } }; await project(db);
  const call = (path, init = {}) => worker.fetch(new Request('https://x' + path, { ...init, headers: { authorization: 'Bearer t', 'content-type': 'application/json' } }), env, { waitUntil() {} });
  for (let i = 0; i < 3; i++) { const r = await call('/api/projects/p1/reviewer-observations-legacy', { method: 'POST', body: JSON.stringify({ participant_hash: 'a' + i, ai_confidence: .7, ai_correct: true, human_accept: true, response_ms: 500 }) }); assert.equal(r.status, 201); }
  assert.equal(db.raw.prepare(`SELECT reviewer_obs_count n FROM projects WHERE id='p1'`).get().n, 3);
  const d = await (await call('/api/projects/p1')).json(); assert.equal(d.human_reviews, 3);
  const list = await (await call('/api/projects')).json(); assert.equal(list.projects[0].candidate_count, 0);
});

test('seeded candidates update projects.candidate_count in the same batch', async () => {
  const db = makeDb(); const pid = await seedProject(db, { candidates: 12, reviewer: 5, episodes: 3 });
  const p = db.raw.prepare(`SELECT candidate_count c, reviewer_obs_count r FROM projects WHERE id=?`).get(pid); assert.deepEqual({ ...p }, { c: 12, r: 5 });
});
