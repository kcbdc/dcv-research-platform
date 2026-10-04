# D1 profile v0.9.5 — AI research lab read guard

The autonomous 10-agent lab now uses bounded evidence samples plus materialized cycle totals.

Key changes:
- candidate snapshot rows: up to 501 -> 40 representative rows
- simulation snapshot rows: up to 1001 -> 240 latest rows
- candidate/simulation totals: `project_cycle_stats` instead of rescanning full result tables
- snapshot cache signature no longer includes generic `projects.updated_at`
- human QC eligibility: one participant aggregate CTE instead of correlated COUNT subqueries per observation
- lab UI polling: 60s -> 120s
- unchanged lab status poll: one `lab_campaigns` indexed probe then HTTP 304; task/source/document history is not reloaded
- final-review evidence refresh: explicit leader-desk click rather than every status render
- dedicated indexes added in migration 0029

The percentages implied by row caps are query-shape reductions, not Cloudflare billing measurements. Production verification should use D1 Analytics / REST `meta.rows_read` after deployment.
