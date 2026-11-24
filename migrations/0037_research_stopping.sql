CREATE TABLE IF NOT EXISTS research_stopping_rules (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 research_cycle INTEGER NOT NULL,
 rule_hash TEXT NOT NULL,
 rule_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,research_cycle)
);
