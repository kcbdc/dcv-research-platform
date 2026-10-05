# v0.10.5 — D1 runtime read optimization

- Added `data_sources.next_fetch_at` and an indexed due-source path. Scheduler/collector no longer computes `datetime(last_fetched_at + cadence)` across source rows on every tick.
- Added `data_sources.coverage_json`; Official Data status no longer GROUP BY/COUNT/MIN/MAX scans `official_observations` every time the dashboard opens.
- Official/FDIC/general collectors advance `next_fetch_at` explicitly; partial pagination remains immediately resumable.
- GitHub Actions skips global `scheduleAll()` probes when due jobs are already queued by event dispatch.
- Fallback cron reduced from 15 to 30 minutes. Event-driven dispatch remains immediate; cron is recovery only.
- Runner progress candidate counts now use `project_cycle_stats` instead of rescanning current `design_candidates`.
- Added covering indexes for due sources, current validations, reports, and job claims.
