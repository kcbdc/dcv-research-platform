-- v0.10.9: repair negative/over-drifted materialized candidate counters.
-- project_cycle_stats is derived cache only; rebuild from authoritative candidate/run tables.
DROP TRIGGER IF EXISTS trg_cycle_stats_candidate_insert;
DROP TRIGGER IF EXISTS trg_cycle_stats_candidate_update;
DROP TRIGGER IF EXISTS trg_cycle_stats_candidate_delete;
DROP TRIGGER IF EXISTS trg_cycle_stats_run_insert;

DELETE FROM project_cycle_stats;

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
GROUP BY project_id,research_cycle;

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

CREATE TRIGGER trg_cycle_stats_candidate_insert
AFTER INSERT ON design_candidates
BEGIN
  INSERT OR IGNORE INTO project_cycle_stats(project_id,research_cycle) VALUES(NEW.project_id,NEW.research_cycle);
  UPDATE project_cycle_stats SET
    candidate_total=MAX(0,candidate_total+1),
    candidate_pending=MAX(0,candidate_pending + CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END),
    candidate_active=MAX(0,candidate_active + CASE WHEN NEW.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END),
    candidate_feasible=MAX(0,candidate_feasible + CASE WHEN NEW.status='confirmed_feasible' THEN 1 ELSE 0 END),
    candidate_infeasible=MAX(0,candidate_infeasible + CASE WHEN NEW.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END),
    candidate_unresolved=MAX(0,candidate_unresolved + CASE WHEN NEW.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END),
    boundary_sum=MAX(0,boundary_sum + COALESCE(NEW.boundary_score,0)),
    boundary_count=MAX(0,boundary_count + CASE WHEN NEW.boundary_score IS NOT NULL THEN 1 ELSE 0 END),
    regret_updated_at=CASE WHEN NEW.max_regret IS NOT NULL THEN COALESCE(NEW.updated_at,regret_updated_at) ELSE regret_updated_at END
  WHERE project_id=NEW.project_id AND research_cycle=NEW.research_cycle;
END;

CREATE TRIGGER trg_cycle_stats_candidate_update
AFTER UPDATE OF status,evidence_status,boundary_score,max_regret,updated_at ON design_candidates
WHEN OLD.project_id=NEW.project_id AND OLD.research_cycle=NEW.research_cycle
BEGIN
  UPDATE project_cycle_stats SET
    candidate_pending=MAX(0,candidate_pending - CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END + CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END),
    candidate_active=MAX(0,candidate_active - CASE WHEN OLD.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END + CASE WHEN NEW.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END),
    candidate_feasible=MAX(0,candidate_feasible - CASE WHEN OLD.status='confirmed_feasible' THEN 1 ELSE 0 END + CASE WHEN NEW.status='confirmed_feasible' THEN 1 ELSE 0 END),
    candidate_infeasible=MAX(0,candidate_infeasible - CASE WHEN OLD.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END + CASE WHEN NEW.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END),
    candidate_unresolved=MAX(0,candidate_unresolved - CASE WHEN OLD.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END + CASE WHEN NEW.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END),
    boundary_sum=MAX(0,boundary_sum - COALESCE(OLD.boundary_score,0) + COALESCE(NEW.boundary_score,0)),
    boundary_count=MAX(0,boundary_count - CASE WHEN OLD.boundary_score IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN NEW.boundary_score IS NOT NULL THEN 1 ELSE 0 END),
    regret_updated_at=CASE WHEN NEW.max_regret IS NOT NULL THEN COALESCE(NEW.updated_at,regret_updated_at) ELSE regret_updated_at END
  WHERE project_id=NEW.project_id AND research_cycle=NEW.research_cycle;
END;

CREATE TRIGGER trg_cycle_stats_candidate_delete
AFTER DELETE ON design_candidates
BEGIN
  UPDATE project_cycle_stats SET
    candidate_total=MAX(0,candidate_total-1),
    candidate_pending=MAX(0,candidate_pending-CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END),
    candidate_active=MAX(0,candidate_active-CASE WHEN OLD.status IN ('pending','unresolved','provisionally_feasible') THEN 1 ELSE 0 END),
    candidate_feasible=MAX(0,candidate_feasible-CASE WHEN OLD.status='confirmed_feasible' THEN 1 ELSE 0 END),
    candidate_infeasible=MAX(0,candidate_infeasible-CASE WHEN OLD.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END),
    candidate_unresolved=MAX(0,candidate_unresolved-CASE WHEN OLD.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END),
    boundary_sum=MAX(0,boundary_sum-COALESCE(OLD.boundary_score,0)),
    boundary_count=MAX(0,boundary_count-CASE WHEN OLD.boundary_score IS NOT NULL THEN 1 ELSE 0 END)
  WHERE project_id=OLD.project_id AND research_cycle=OLD.research_cycle;
END;

CREATE TRIGGER trg_cycle_stats_run_insert
AFTER INSERT ON simulation_runs
BEGIN
  INSERT OR IGNORE INTO project_cycle_stats(project_id,research_cycle)
    SELECT NEW.project_id,research_cycle FROM design_candidates WHERE id=NEW.candidate_id;
  UPDATE project_cycle_stats SET
    simulation_total=MAX(0,simulation_total+1),
    simulation_exploration=MAX(0,simulation_exploration+CASE WHEN NEW.phase='exploration' THEN 1 ELSE 0 END),
    simulation_refinement=MAX(0,simulation_refinement+CASE WHEN NEW.phase='refinement' THEN 1 ELSE 0 END),
    simulation_confirmation=MAX(0,simulation_confirmation+CASE WHEN NEW.phase='confirmation' THEN 1 ELSE 0 END),
    simulation_robust=MAX(0,simulation_robust+CASE WHEN NEW.phase IN ('historical','stress') THEN 1 ELSE 0 END),
    latest_simulation_at=CASE WHEN latest_simulation_at IS NULL OR NEW.created_at>latest_simulation_at THEN NEW.created_at ELSE latest_simulation_at END
  WHERE project_id=NEW.project_id AND research_cycle=(SELECT research_cycle FROM design_candidates WHERE id=NEW.candidate_id);
END;
