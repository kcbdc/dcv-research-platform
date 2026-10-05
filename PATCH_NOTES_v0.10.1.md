# v0.10.1 — D1 preflight and stale-lock recovery

- GitHub Actions applies pending remote D1 migrations before compute.
- Preflight now requires `project_cycle_stats`, preventing false preflight success.
- Missing stats schema reports `MIGRATION_0027_MISSING` with remediation metadata.
- Stale job lock recovery stores a stable machine code and UI shows a Korean recovery notice rather than a raw red error.
- Existing research data are preserved; migrations only repair derived/cache schema.
