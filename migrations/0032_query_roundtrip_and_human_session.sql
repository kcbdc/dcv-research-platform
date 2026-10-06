-- v0.10.8: D1 read/write amplification reduction for human/report hot paths.
-- reviewer_observations remains source of truth. Project counters are derived and backfilled once.

ALTER TABLE projects ADD COLUMN reviewer_participant_count INTEGER NOT NULL DEFAULT 0;

UPDATE projects
SET reviewer_obs_count=(SELECT COUNT(*) FROM reviewer_observations o WHERE o.project_id=projects.id),
    reviewer_participant_count=(SELECT COUNT(DISTINCT o.participant_hash) FROM reviewer_observations o WHERE o.project_id=projects.id AND o.participant_hash IS NOT NULL AND o.participant_hash<>'anonymous'),
    reviewer_last_observed_at=(SELECT MAX(o.created_at) FROM reviewer_observations o WHERE o.project_id=projects.id);

CREATE INDEX IF NOT EXISTS idx_reviewer_obs_project_participant
  ON reviewer_observations(project_id,participant_hash)
  WHERE participant_hash IS NOT NULL AND participant_hash<>'anonymous';

-- One trigger owns all observation-derived project counters/markers.
-- This removes one explicit projects UPDATE statement from every human response.
DROP TRIGGER IF EXISTS trg_projects_reviewer_last_observed;
CREATE TRIGGER trg_projects_reviewer_last_observed
AFTER INSERT ON reviewer_observations
BEGIN
  UPDATE projects SET
    reviewer_obs_count=reviewer_obs_count+1,
    reviewer_participant_count=reviewer_participant_count + CASE
      WHEN NEW.participant_hash IS NOT NULL AND NEW.participant_hash<>'anonymous'
       AND NOT EXISTS(
         SELECT 1 FROM reviewer_observations o
         WHERE o.project_id=NEW.project_id AND o.participant_hash=NEW.participant_hash AND o.id<>NEW.id
         LIMIT 1
       ) THEN 1 ELSE 0 END,
    reviewer_last_observed_at=CASE WHEN reviewer_last_observed_at IS NULL OR NEW.created_at>reviewer_last_observed_at THEN NEW.created_at ELSE reviewer_last_observed_at END,
    reviewer_hold_marker=NULL
  WHERE id=NEW.project_id;
END;

CREATE INDEX IF NOT EXISTS idx_reports_project_created_desc
  ON reports(project_id,created_at DESC);

-- Rare maintenance paths: keep derived counters exact if observations are corrected or deleted.
DROP TRIGGER IF EXISTS trg_projects_reviewer_participant_update;
CREATE TRIGGER trg_projects_reviewer_participant_update
AFTER UPDATE OF participant_hash ON reviewer_observations
WHEN OLD.participant_hash IS NOT NEW.participant_hash
BEGIN
  UPDATE projects SET reviewer_participant_count=(
    SELECT COUNT(DISTINCT o.participant_hash) FROM reviewer_observations o
    WHERE o.project_id=NEW.project_id AND o.participant_hash IS NOT NULL AND o.participant_hash<>'anonymous'
  ) WHERE id=NEW.project_id;
  UPDATE projects SET reviewer_participant_count=(
    SELECT COUNT(DISTINCT o.participant_hash) FROM reviewer_observations o
    WHERE o.project_id=OLD.project_id AND o.participant_hash IS NOT NULL AND o.participant_hash<>'anonymous'
  ) WHERE id=OLD.project_id AND OLD.project_id<>NEW.project_id;
END;

DROP TRIGGER IF EXISTS trg_projects_reviewer_observation_delete;
CREATE TRIGGER trg_projects_reviewer_observation_delete
AFTER DELETE ON reviewer_observations
BEGIN
  UPDATE projects SET
    reviewer_obs_count=MAX(0,reviewer_obs_count-1),
    reviewer_participant_count=(SELECT COUNT(DISTINCT o.participant_hash) FROM reviewer_observations o WHERE o.project_id=OLD.project_id AND o.participant_hash IS NOT NULL AND o.participant_hash<>'anonymous'),
    reviewer_last_observed_at=(SELECT MAX(o.created_at) FROM reviewer_observations o WHERE o.project_id=OLD.project_id)
  WHERE id=OLD.project_id;
END;
