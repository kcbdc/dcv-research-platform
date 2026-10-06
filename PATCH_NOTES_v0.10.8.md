# DCV Research Platform v0.10.8 — Query Merge & Human Counter Materialization

This release compares the user-supplied `dcv-v0.10.7-db-query-patch.zip` with the repository v0.10.7 baseline and merges the safe parts while rejecting two regressions.

## Adopted from the supplied patch
- Project-detail polling skips the expensive publication-readiness aggregate.
- `eligible_participants` compatibility alias is restored so the live current-protocol count does not show as zero.
- Report GET batches project + definition reads and overlaps stored-report loading with live human statistics.

## Intentionally not adopted
- Protocol participant counting through `reviewer_observations.context_json` was rejected. It drops research-cycle isolation and reintroduces JSON-expression work. v0.10.8 keeps `reviewer_trials(project_id, protocol_version, research_cycle, ...)` as the normalized source.
- Removing the latest-observation marker semantics was rejected. The scheduler still depends on `reviewer_last_observed_at`; the database trigger remains authoritative.

## Additional tuning
- Project detail groups independent reads into two D1 batches and overlaps empirical/protocol/gate/human reads. This reduces Worker↔D1 round trips without changing result rows.
- Human-session verification accepts an already-loaded research cycle. Trial issue + trial submit no longer re-read `projects` only to discover the same cycle. For 32 participants × 43 trials, this removes up to 2,752 one-row project reads across a full human study.
- `projects.reviewer_participant_count` materializes cumulative distinct human participants. Detail/report polling no longer scans all reviewer observations to recompute `COUNT(DISTINCT participant_hash)`.
- A single observation trigger owns `reviewer_obs_count`, `reviewer_participant_count`, `reviewer_last_observed_at`, and hold-marker clearing. Explicit duplicate `projects` updates were removed from human response/legacy import paths.
- Rare observation corrections/deletes recompute the derived participant count to keep maintenance operations exact.
- D1 profiler now models SELECT statements inside `DB.batch()` correctly.

## Migration
Apply `migrations/0032_query_roundtrip_and_human_session.sql` before deploying v0.10.8.
