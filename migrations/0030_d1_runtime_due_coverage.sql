-- v0.10.5: D1 runtime read guard.
-- 1) Make collector due checks indexable (avoid datetime() on every data_sources row).
-- 2) Persist connector coverage so dashboard status does not aggregate official_observations on every open.

ALTER TABLE data_sources ADD COLUMN next_fetch_at TEXT;
ALTER TABLE data_sources ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '{}';

UPDATE data_sources
SET next_fetch_at = CASE
  WHEN enabled=0 THEN NULL
  WHEN last_fetched_at IS NULL THEN '1970-01-01T00:00:00.000Z'
  ELSE strftime('%Y-%m-%dT%H:%M:%fZ', datetime(last_fetched_at, '+' || cadence_minutes || ' minutes'))
END
WHERE next_fetch_at IS NULL;

UPDATE data_sources
SET coverage_json=json_object('rows',COALESCE(last_record_count,0))
WHERE connector_id IS NOT NULL AND (coverage_json IS NULL OR coverage_json='{}');

CREATE INDEX IF NOT EXISTS idx_sources_next_due
  ON data_sources(project_id,enabled,next_fetch_at,id);

CREATE INDEX IF NOT EXISTS idx_validations_candidate_revision_type_created
  ON validations(candidate_id,evidence_revision,validation_type,created_at DESC,status);

CREATE INDEX IF NOT EXISTS idx_reports_current
  ON reports(project_id,research_cycle,evidence_revision,stale_at,created_at DESC);

-- Keep idx_jobs_claim as the queue-order covering index. A run_after-first index caused SQLite
-- to build a temporary B-tree for priority ordering and was therefore deliberately omitted.
