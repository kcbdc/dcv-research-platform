# DCV Research Platform v0.10.7 — Query Compaction & Integrity Review

This release focuses on D1 read efficiency and correctness of human-evidence scope. It intentionally avoids broad new materialized tables where write amplification would outweigh read savings.

## D1 query compaction

- `snapshot()` now reads candidate/run totals from `project_cycle_stats` rather than rescanning `design_candidates` and `simulation_runs`.
- `approvalGates()` is reduced to one indexed statement using `EXISTS` predicates instead of multiple D1 round-trips.
- `generateReport()` reuses thesis project metadata instead of issuing a redundant project-name query.
- The scheduler no longer polls `reviewer_observations ORDER BY created_at DESC` on each cycle. `projects.reviewer_last_observed_at` is maintained by a D1 trigger and read directly.
- Added covering indexes for current human trials, observations, QC flags, protocol lookup, validation/approval gates, and evidence snapshots.

## Human-evidence correctness fixes

- Current-protocol participant counts now come from normalized `reviewer_trials` in the current research cycle, not JSON tags on observations.
- Reviewer-model fitting is restricted to current-cycle, current-protocol, main-phase trial rows joined by `trial_id`; old-cycle observations can no longer leak into the current model.
- Fast-response exclusion now uses **main trials only** in both numerator and denominator. Practice/attention speed can no longer falsely exclude a participant.
- QC aggregation is research-cycle scoped; historical trials no longer contaminate current-cycle quality flags.
- Thesis human summaries use configurable protocol thresholds (`human_main_n`, `human_attention_n`, fast/slow limits) instead of hard-coded 30/3 values and correlated per-row subqueries.
- Legacy observations remain available for sensitivity analysis but are not silently treated as current-protocol evidence.

## Migration

Apply `migrations/0031_query_hotpath_compaction.sql` before deployment. It:

- adds/backfills `projects.reviewer_last_observed_at`,
- installs an observation trigger to maintain it,
- adds the hot-path indexes used by v0.10.7.

No source-of-truth observation rows are rewritten.

## Verification

- Full regression suite: **249/249 PASS**.
- JS/MJS syntax check: PASS.
- Migration verifier: **21 migration files verified**.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- Scientific submission source bundle regenerated.
- Deterministic result checksum unchanged: `5eb26fca26edd573`.

## D1 profiler comparison

Repository profiler estimates (not Cloudflare billing measurements):

- 24h steady-state rows read: **1,440 → 1,296 (-10.0%)**.
- 24h steady-state queries: **1,777 → 1,633 (-8.1%)**.
- Project-detail API: **25 → 19 queries (-24%)**.
- Thesis read estimate: **1,989 → 1,869 rows (-6.0%)**.
- Candidate-export read estimate: **1,873 → 1,753 rows (-6.4%)**.

Production confirmation should use Cloudflare D1 `meta.rows_read` and Analytics after migration/deployment.
