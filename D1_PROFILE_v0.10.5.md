# D1 profile v0.10.5 — runtime read tuning

Baseline: v0.10.4 local deterministic profiler, 15-minute fallback cron.
Tuned: v0.10.5, event-driven dispatch unchanged, recovery cron 30 minutes.

## Measured repository profiler

- Regression tests: 242/242 PASS.
- Result checksum unchanged: `5eb26fca26edd573`.
- Estimated 24h steady-state rows read: **2,880 -> 1,440 (-50%)** in the deterministic cron model.
- Steady-state selects: **2,592 -> 1,296 (-50%)**.
- Steady-state writes: **965 -> 485 (-49.7%)**.
- Thesis/export read estimates also fall slightly from the new covering indexes; output semantics are unchanged.

These are SQLite/EXPLAIN-based repository estimates, not Cloudflare billing measurements. Production verification must use D1 `meta.rows_read` / Analytics.

## Structural changes

1. `data_sources.next_fetch_at` turns due-source checks into indexed comparisons instead of `datetime(last_fetched_at + cadence)` expressions.
2. `data_sources.coverage_json` persists connector coverage; dashboard status no longer aggregates `official_observations` on each open.
3. GitHub Actions skips global scheduling probes when event dispatch already left due durable jobs in D1.
4. Fallback cron is 30 minutes; event-triggered dispatch remains immediate.
5. Runner progress candidate totals use `project_cycle_stats` instead of scanning `design_candidates`.
6. Added hot-path indexes for validations and current reports while retaining `idx_jobs_claim` for queue ordering.
