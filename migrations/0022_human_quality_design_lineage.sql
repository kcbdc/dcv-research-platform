-- Human-review quality-control v2 + design lineage / integrity audit
ALTER TABLE reviewer_trials ADD COLUMN protocol_version TEXT NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE reviewer_trials ADD COLUMN trial_phase TEXT NOT NULL DEFAULT 'main';
ALTER TABLE reviewer_trials ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviewer_trials ADD COLUMN attention_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviewer_trials ADD COLUMN expected_accept INTEGER;
ALTER TABLE reviewer_trials ADD COLUMN completed_at TEXT;

ALTER TABLE design_candidates ADD COLUMN design_key TEXT;
CREATE INDEX IF NOT EXISTS idx_candidate_design_key ON design_candidates(project_id,design_key,research_cycle);
CREATE INDEX IF NOT EXISTS idx_reviewer_trial_protocol ON reviewer_trials(project_id,protocol_version,participant_hash,trial_phase,status);

CREATE TABLE IF NOT EXISTS reviewer_quality_flags (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 participant_hash TEXT NOT NULL,
 protocol_version TEXT NOT NULL,
 research_cycle INTEGER NOT NULL,
 evidence_revision INTEGER NOT NULL,
 flag_code TEXT NOT NULL,
 severity TEXT NOT NULL,
 detail_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL,
 UNIQUE(project_id,participant_hash,protocol_version,research_cycle,evidence_revision,flag_code)
);
CREATE INDEX IF NOT EXISTS idx_reviewer_quality_scope ON reviewer_quality_flags(project_id,protocol_version,research_cycle,evidence_revision,severity);

CREATE TABLE IF NOT EXISTS research_integrity_checks (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 research_cycle INTEGER NOT NULL,
 evidence_revision INTEGER NOT NULL,
 check_code TEXT NOT NULL,
 status TEXT NOT NULL,
 detail_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integrity_scope ON research_integrity_checks(project_id,research_cycle,evidence_revision,created_at);

CREATE TABLE IF NOT EXISTS reviewer_sessions (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 participant_hash TEXT NOT NULL,
 protocol_version TEXT NOT NULL,
 research_cycle INTEGER NOT NULL,
 evidence_revision INTEGER NOT NULL,
 quiz_attempts INTEGER NOT NULL DEFAULT 0,
 quiz_passed INTEGER NOT NULL DEFAULT 0,
 started_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(project_id,participant_hash,protocol_version,research_cycle)
);
CREATE INDEX IF NOT EXISTS idx_reviewer_session_scope ON reviewer_sessions(project_id,protocol_version,research_cycle,quiz_passed);
