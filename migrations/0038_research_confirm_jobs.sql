CREATE TABLE IF NOT EXISTS research_confirm_jobs (
 project_id TEXT NOT NULL, cycle INTEGER NOT NULL, revision INTEGER NOT NULL,
 hash TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL, created_at TEXT NOT NULL,
 result_json TEXT, code_revision TEXT,
 PRIMARY KEY(project_id,cycle,revision)
);
