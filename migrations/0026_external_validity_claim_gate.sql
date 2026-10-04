-- v0.8.8: external-validity evidence registry and claim-scope gate
CREATE TABLE IF NOT EXISTS external_validity_datasets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  jurisdiction TEXT,
  source_type TEXT NOT NULL DEFAULT 'external_records',
  actual_public_payment INTEGER NOT NULL DEFAULT 0,
  outcome_ground_truth INTEGER NOT NULL DEFAULT 0,
  independent_source INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  data_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'REGISTERED',
  created_at TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE(project_id,data_hash),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_external_validity_dataset_project ON external_validity_datasets(project_id,status,actual_public_payment,outcome_ground_truth);

CREATE TABLE IF NOT EXISTS external_validity_evaluations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  research_cycle INTEGER NOT NULL,
  candidate_id TEXT,
  status TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',
  analysis_code_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  implementation_scope TEXT NOT NULL DEFAULT 'dcv_platform',
  independent_implementation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(dataset_id) REFERENCES external_validity_datasets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_external_validity_eval_project ON external_validity_evaluations(project_id,research_cycle,status);
CREATE INDEX IF NOT EXISTS idx_external_validity_eval_dataset ON external_validity_evaluations(dataset_id,status);
