-- v0.8.6 realized rigor and participant invite controls
CREATE TABLE IF NOT EXISTS reviewer_invites (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, research_cycle INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT, subject_hash TEXT, request_fingerprint_hash TEXT, status TEXT NOT NULL DEFAULT 'unused', participant_hash TEXT, created_at TEXT NOT NULL, used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviewer_invites_project_cycle ON reviewer_invites(project_id,research_cycle,status);

ALTER TABLE reviewer_sessions ADD COLUMN subject_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_reviewer_sessions_subject ON reviewer_sessions(project_id,research_cycle,subject_hash);
