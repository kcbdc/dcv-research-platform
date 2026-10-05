# v0.10.2 — D1 Migration Ledger Reconciliation

- Fixes legacy D1 databases whose schema was manually/previously applied but whose `d1_migrations` ledger is incomplete.
- Before Wrangler applies pending migrations, CI now inspects live schema artifacts and records only migrations whose tables/columns/indexes/triggers are already fully present.
- Prevents `0004_cdrs_engine.sql` from being re-run against an existing `design_candidates.estimator` column.
- Refuses unsafe partial reconciliation when a migration with non-idempotent `ALTER TABLE ... ADD COLUMN` is only partly present.
- Keeps normal Wrangler migrations for genuinely pending migrations.
