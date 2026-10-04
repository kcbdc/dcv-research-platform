-- v0.8.2: participant/public auth separation and settings-bound human protocol hash
ALTER TABLE reviewer_sessions ADD COLUMN session_token_hash TEXT;
ALTER TABLE reviewer_trials ADD COLUMN protocol_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_reviewer_session_token ON reviewer_sessions(project_id,participant_hash,protocol_version,research_cycle,session_token_hash);
