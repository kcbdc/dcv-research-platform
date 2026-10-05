-- v0.10.7: compact hot-path queries and cover current-cycle human/research gate lookups.
-- No source-of-truth observations are rewritten. A denormalized latest-observation marker is backfilled once.

ALTER TABLE projects ADD COLUMN reviewer_last_observed_at TEXT;
UPDATE projects SET reviewer_last_observed_at=(SELECT MAX(o.created_at) FROM reviewer_observations o WHERE o.project_id=projects.id)
WHERE reviewer_last_observed_at IS NULL AND COALESCE(reviewer_obs_count,0)>0;

CREATE INDEX IF NOT EXISTS idx_trials_current_participant_phase_status
  ON reviewer_trials(project_id,protocol_version,research_cycle,participant_hash,trial_phase,status,attention_check,created_at);

CREATE INDEX IF NOT EXISTS idx_obs_project_participant_trial_time
  ON reviewer_observations(project_id,participant_hash,trial_id,created_at,response_ms);

CREATE INDEX IF NOT EXISTS idx_quality_current_exclude
  ON reviewer_quality_flags(project_id,protocol_version,research_cycle,participant_hash,severity);

CREATE INDEX IF NOT EXISTS idx_protocol_cycle_lookup
  ON research_protocols(project_id,research_cycle,version DESC,protocol_hash);

CREATE INDEX IF NOT EXISTS idx_validation_gate_current
  ON validations(project_id,validation_type,status,evidence_revision,candidate_id);

CREATE INDEX IF NOT EXISTS idx_approval_gate_decision
  ON approvals(project_id,research_cycle,evidence_revision,decision,stale_at,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_snapshot_project_revision
  ON evidence_snapshots(project_id,research_cycle,evidence_revision,created_at DESC);

DROP TRIGGER IF EXISTS trg_projects_reviewer_last_observed;
CREATE TRIGGER trg_projects_reviewer_last_observed
AFTER INSERT ON reviewer_observations
BEGIN
  UPDATE projects SET
    reviewer_last_observed_at=CASE WHEN reviewer_last_observed_at IS NULL OR NEW.created_at>reviewer_last_observed_at THEN NEW.created_at ELSE reviewer_last_observed_at END,
    reviewer_hold_marker=NULL
  WHERE id=NEW.project_id;
END;
