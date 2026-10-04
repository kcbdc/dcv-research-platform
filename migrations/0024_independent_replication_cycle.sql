-- v0.8.5: preregistered independent replication cycle
CREATE TABLE IF NOT EXISTS independent_replications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_cycle INTEGER NOT NULL,
  replication_cycle INTEGER NOT NULL,
  source_candidate_id TEXT NOT NULL,
  source_design_key TEXT,
  source_protocol_hash TEXT,
  replication_protocol_hash TEXT,
  locked_design_json TEXT NOT NULL,
  locked_constraints_json TEXT NOT NULL,
  locked_benchmark_json TEXT NOT NULL,
  locked_validation_json TEXT NOT NULL,
  locked_empirical_json TEXT NOT NULL DEFAULT '{}',
  locked_scenarios_json TEXT NOT NULL DEFAULT '{}',
  seed_salt TEXT NOT NULL,
  scenario_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREREGISTERED',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_id, replication_cycle),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_independent_replication_project ON independent_replications(project_id, status, replication_cycle DESC);
