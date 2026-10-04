# D1 read profile — v0.9.2

Local EXPLAIN-based profiler fixture: 96 candidates, 374 simulation runs, 400 reviewer observations.

| Metric | v0.9.1 | v0.9.2 | Change |
|---|---:|---:|---:|
| 24h / 96 scheduler ticks rows_read_estimate | 12,000 | 2,880 | -76% |
| Workflow cron fallback | 5 min (288/day) | 15 min (96/day) | -67% invocations |
| Scheduler simple daily-equivalent | ~36,000 | ~2,880 | ~-92% |

`rows_read_estimate` is a repository-side EXPLAIN estimate, not Cloudflare billing data. v0.9.2 also records Cloudflare REST `meta.rows_read` as `d1_rows_read` in Actions logs so production readings can be compared directly.
