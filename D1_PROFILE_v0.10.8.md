# D1 profile v0.10.8

The existing deterministic profiler still reports statement-level rows read. Batching therefore does not artificially lower rows-read estimates, but it does lower remote D1 round trips.

Key changes vs v0.10.7:
- current-protocol participant count remains on normalized `reviewer_trials`;
- publication-readiness aggregation is skipped on high-frequency project-detail polling;
- cumulative distinct participant count is materialized on `projects`;
- one project-cycle lookup is removed from each human trial issue and each trial response when the caller already loaded the cycle;
- report/detail independent reads are coalesced into D1 batches.

Endpoint profiler after tuning (fixture-dependent):
- project detail: 19 SQL statements, no full-table scans; independent statements are grouped into fewer remote batches;
- report: 4 SQL statements, no full-table scans;
- thesis/export retain their existing bounded indexed queries.

For a full 32-participant protocol (43 issued/responded trials each), known-cycle session verification alone removes up to 2,752 redundant one-row `projects` reads. The materialized participant counter additionally removes repeated `COUNT(DISTINCT ...)` observation scans from dashboard/report polling.
