-- v0.9.2: D1 Free-tier rows-read optimization.
-- Materialize current cycle counters so dashboard/orchestrator do not repeatedly aggregate
-- design_candidates/simulation_runs. Also add selective covering indexes for hot paths.

CREATE TABLE IF NOT EXISTS project_cycle_stats (
  project_id TEXT NOT NULL,
  research_cycle INTEGER NOT NULL,
  candidate_total INTEGER NOT NULL DEFAULT 0,
  candidate_pending INTEGER NOT NULL DEFAULT 0,
  candidate_active INTEGER NOT NULL DEFAULT 0,
  candidate_feasible INTEGER NOT NULL DEFAULT 0,
  candidate_infeasible INTEGER NOT NULL DEFAULT 0,
  candidate_unresolved INTEGER NOT NULL DEFAULT 0,
  boundary_sum REAL NOT NULL DEFAULT 0,
  boundary_count INTEGER NOT NULL DEFAULT 0,
  simulation_total INTEGER NOT NULL DEFAULT 0,
  simulation_exploration INTEGER NOT NULL DEFAULT 0,
  simulation_refinement INTEGER NOT NULL DEFAULT 0,
  simulation_confirmation INTEGER NOT NULL DEFAULT 0,
  simulation_robust INTEGER NOT NULL DEFAULT 0,
  latest_simulation_at TEXT,
  regret_updated_at TEXT,
  PRIMARY KEY(project_id,research_cycle),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Backfill candidate aggregates once at migration time.
INSERT INTO project_cycle_stats(
  project_id,research_cycle,candidate_total,candidate_pending,candidate_active,candidate_feasible,candidate_infeasible,
  candidate_unresolved,boundary_sum,boundary_count,regret_updated_at
)
SELECT project_id,research_cycle,
  COUNT(*),
  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END),
  SUM(CASE WHEN status='confirmed_feasible' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END),
  SUM(CASE WHEN evidence_status='UNRESOLVED' THEN 1 ELSE 0 END),
  COALESCE(SUM(CASE WHEN boundary_score IS NOT NULL THEN boundary_score ELSE 0 END),0),
  SUM(CASE WHEN boundary_score IS NOT NULL THEN 1 ELSE 0 END),
  MAX(CASE WHEN max_regret IS NOT NULL THEN updated_at END)
FROM design_candidates
GROUP BY project_id,research_cycle
ON CONFLICT(project_id,research_cycle) DO UPDATE SET
  candidate_total=excluded.candidate_total,
  candidate_pending=excluded.candidate_pending,
  candidate_active=excluded.candidate_active,
  candidate_feasible=excluded.candidate_feasible,
  candidate_infeasible=excluded.candidate_infeasible,
  candidate_unresolved=excluded.candidate_unresolved,
  boundary_sum=excluded.boundary_sum,
  boundary_count=excluded.boundary_count,
  regret_updated_at=excluded.regret_updated_at;

-- Backfill run aggregates, resolving cycle through the candidate once.
INSERT INTO project_cycle_stats(
  project_id,research_cycle,simulation_total,simulation_exploration,simulation_refinement,
  simulation_confirmation,simulation_robust,latest_simulation_at
)
SELECT r.project_id,c.research_cycle,
  COUNT(*),
  SUM(CASE WHEN r.phase='exploration' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.phase='refinement' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.phase='confirmation' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.phase IN ('historical','stress') THEN 1 ELSE 0 END),
  MAX(r.created_at)
FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id
GROUP BY r.project_id,c.research_cycle
ON CONFLICT(project_id,research_cycle) DO UPDATE SET
  simulation_total=excluded.simulation_total,
  simulation_exploration=excluded.simulation_exploration,
  simulation_refinement=excluded.simulation_refinement,
  simulation_confirmation=excluded.simulation_confirmation,
  simulation_robust=excluded.simulation_robust,
  latest_simulation_at=excluded.latest_simulation_at;

CREATE TRIGGER IF NOT EXISTS trg_cycle_stats_candidate_insert
AFTER INSERT ON design_candidates
BEGIN
  INSERT OR IGNORE INTO project_cycle_stats(project_id,research_cycle) VALUES(NEW.project_id,NEW.research_cycle);
  UPDATE project_cycle_stats SET
    candidate_total=candidate_total+1,
    candidate_pending=candidate_pending + CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END,
    candidate_active=candidate_active + CASE WHEN NEW.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END,
    candidate_feasible=candidate_feasible + CASE WHEN NEW.status='confirmed_feasible' THEN 1 ELSE 0 END,
    candidate_infeasible=candidate_infeasible + CASE WHEN NEW.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END,
    candidate_unresolved=candidate_unresolved + CASE WHEN NEW.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END,
    boundary_sum=boundary_sum + COALESCE(NEW.boundary_score,0),
    boundary_count=boundary_count + CASE WHEN NEW.boundary_score IS NOT NULL THEN 1 ELSE 0 END,
    regret_updated_at=CASE WHEN NEW.max_regret IS NOT NULL THEN COALESCE(NEW.updated_at,regret_updated_at) ELSE regret_updated_at END
  WHERE project_id=NEW.project_id AND research_cycle=NEW.research_cycle;
END;

CREATE TRIGGER IF NOT EXISTS trg_cycle_stats_candidate_update
AFTER UPDATE OF status,evidence_status,boundary_score,max_regret,updated_at ON design_candidates
WHEN OLD.project_id=NEW.project_id AND OLD.research_cycle=NEW.research_cycle
BEGIN
  UPDATE project_cycle_stats SET
    candidate_pending=candidate_pending - CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END + CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END,
    candidate_active=candidate_active - CASE WHEN OLD.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END + CASE WHEN NEW.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END,
    candidate_feasible=candidate_feasible - CASE WHEN OLD.status='confirmed_feasible' THEN 1 ELSE 0 END + CASE WHEN NEW.status='confirmed_feasible' THEN 1 ELSE 0 END,
    candidate_infeasible=candidate_infeasible - CASE WHEN OLD.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END + CASE WHEN NEW.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END,
    candidate_unresolved=candidate_unresolved - CASE WHEN OLD.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END + CASE WHEN NEW.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END,
    boundary_sum=boundary_sum - COALESCE(OLD.boundary_score,0) + COALESCE(NEW.boundary_score,0),
    boundary_count=boundary_count - CASE WHEN OLD.boundary_score IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN NEW.boundary_score IS NOT NULL THEN 1 ELSE 0 END,
    regret_updated_at=CASE WHEN NEW.max_regret IS NOT NULL THEN COALESCE(NEW.updated_at,regret_updated_at) ELSE regret_updated_at END
  WHERE project_id=NEW.project_id AND research_cycle=NEW.research_cycle;
END;

CREATE TRIGGER IF NOT EXISTS trg_cycle_stats_candidate_delete
AFTER DELETE ON design_candidates
BEGIN
  UPDATE project_cycle_stats SET
    candidate_total=MAX(0,candidate_total-1),
    candidate_pending=MAX(0,candidate_pending-CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END),
    candidate_active=MAX(0,candidate_active-CASE WHEN OLD.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END),
    candidate_feasible=MAX(0,candidate_feasible-CASE WHEN OLD.status='confirmed_feasible' THEN 1 ELSE 0 END),
    candidate_infeasible=MAX(0,candidate_infeasible-CASE WHEN OLD.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END),
    candidate_unresolved=MAX(0,candidate_unresolved-CASE WHEN OLD.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END),
    boundary_sum=boundary_sum-COALESCE(OLD.boundary_score,0),
    boundary_count=MAX(0,boundary_count-CASE WHEN OLD.boundary_score IS NOT NULL THEN 1 ELSE 0 END)
  WHERE project_id=OLD.project_id AND research_cycle=OLD.research_cycle;
END;

CREATE TRIGGER IF NOT EXISTS trg_cycle_stats_run_insert
AFTER INSERT ON simulation_runs
BEGIN
  INSERT OR IGNORE INTO project_cycle_stats(project_id,research_cycle)
    SELECT NEW.project_id,research_cycle FROM design_candidates WHERE id=NEW.candidate_id;
  UPDATE project_cycle_stats SET
    simulation_total=simulation_total+1,
    simulation_exploration=simulation_exploration+CASE WHEN NEW.phase='exploration' THEN 1 ELSE 0 END,
    simulation_refinement=simulation_refinement+CASE WHEN NEW.phase='refinement' THEN 1 ELSE 0 END,
    simulation_confirmation=simulation_confirmation+CASE WHEN NEW.phase='confirmation' THEN 1 ELSE 0 END,
    simulation_robust=simulation_robust+CASE WHEN NEW.phase IN ('historical','stress') THEN 1 ELSE 0 END,
    latest_simulation_at=CASE WHEN latest_simulation_at IS NULL OR NEW.created_at>latest_simulation_at THEN NEW.created_at ELSE latest_simulation_at END
  WHERE project_id=NEW.project_id AND research_cycle=(SELECT research_cycle FROM design_candidates WHERE id=NEW.candidate_id);
END;

-- Hot-path indexes. These are deliberately narrow/covering to reduce rows read, not only latency.
CREATE INDEX IF NOT EXISTS idx_candidates_cycle_regret
  ON design_candidates(project_id,research_cycle,max_regret,id,updated_at)
  WHERE max_regret IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_project_candidate_phase_created
  ON simulation_runs(project_id,candidate_id,phase,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviewer_obs_protocol_phase_participant
  ON reviewer_observations(project_id,json_extract(context_json,'$.protocol'),json_extract(context_json,'$.trial_phase'),participant_hash,created_at);
CREATE INDEX IF NOT EXISTS idx_reviewer_trials_completion
  ON reviewer_trials(project_id,protocol_version,research_cycle,participant_hash,trial_phase,status);
CREATE INDEX IF NOT EXISTS idx_reviewer_quality_exclude
  ON reviewer_quality_flags(project_id,protocol_version,research_cycle,evidence_revision,severity,participant_hash);
