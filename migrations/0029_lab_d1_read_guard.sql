-- v0.9.5: additional D1 free-tier read guards for the autonomous 10-agent research lab.
-- Keep current-cycle snapshot reads bounded and make lab status/activity probes index-friendly.

CREATE INDEX IF NOT EXISTS idx_runs_project_created_candidate
  ON simulation_runs(project_id,created_at DESC,candidate_id);

CREATE INDEX IF NOT EXISTS idx_candidates_project_cycle_status_regret
  ON design_candidates(project_id,research_cycle,status,max_regret,id);

CREATE INDEX IF NOT EXISTS idx_lab_tasks_campaign_status_seq
  ON lab_tasks(campaign_id,status,seq DESC);

CREATE INDEX IF NOT EXISTS idx_lab_tasks_campaign_role_status_seq
  ON lab_tasks(campaign_id,role_id,status,seq DESC);

CREATE INDEX IF NOT EXISTS idx_projects_created_desc
  ON projects(created_at DESC,id);
