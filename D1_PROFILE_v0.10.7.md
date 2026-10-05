# D1 profile v0.10.7 — query compaction

Baseline: v0.10.6 / v0.10.5 runtime-tuned schema.
Tuned: v0.10.7 query compaction and human-evidence scope corrections.

## Deterministic repository profiler

| Metric | Baseline | v0.10.7 | Change |
|---|---:|---:|---:|
| 24h steady-state rows-read estimate | 1,440 | 1,296 | -10.0% |
| 24h steady-state total queries | 1,777 | 1,633 | -8.1% |
| 24h steady-state SELECTs | 1,296 | 1,152 | -11.1% |
| 24h steady-state writes | 481 | 481 | unchanged |
| Project detail queries | 25 | 19 | -24.0% |
| Project detail rows-read estimate | 125 | 119 | -4.8% |
| Thesis rows-read estimate | 1,989 | 1,869 | -6.0% |
| Candidate export rows-read estimate | 1,873 | 1,753 | -6.4% |

Result checksum is unchanged: `5eb26fca26edd573` (374 deterministic result rows).

## Remaining dominant reads

The remaining steady-state reads are primarily necessary validation/run aggregates and durable job state checks. They were not replaced with additional materialized counters in this release because the resulting trigger/write amplification would increase D1 writes and schema complexity for relatively small read savings.

These values are SQLite/EXPLAIN-based repository estimates. Production usage must be verified with Cloudflare D1 `meta.rows_read` / Analytics.
