-- v0.10.10: remove legacy duplicate cycle-stat triggers (root cause of the "stuck at robust" loop).
--
-- Since 0027 the canonical counters are maintained by trg_cycle_stats_candidate_* and
-- trg_cycle_stats_run_insert. Migrations 0027/0028/0033 only DROP their own trigger names, so the
-- older trg_candidate_stats_* (0022) and trg_sim_stats_insert (0023) triggers were never removed.
-- Every candidate/run change was therefore counted twice:
--   candidate_total / candidate_feasible / simulation_* == 2 x the real value.
-- advance_project compares "distinct stress runs" with candidate_feasible, so the pipeline could
-- never satisfy `stress >= feasible`, kept re-entering the robust stage, and never reached
-- validate_project -> External Validation Matrix (BIS/ECB) -> human review.
--
-- trg_sim_stats_delete is intentionally kept: it is the only run-delete handler and does not double count.
DROP TRIGGER IF EXISTS trg_candidate_stats_insert;
DROP TRIGGER IF EXISTS trg_candidate_stats_update;
DROP TRIGGER IF EXISTS trg_candidate_stats_delete;
DROP TRIGGER IF EXISTS trg_sim_stats_insert;

-- project_cycle_stats is derived data: rebuild it from the authoritative tables once.
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

-- Same defect for reviewer counters: 0022's trg_reviewer_obs_project_count_* still ran next to
-- 0032's trg_projects_reviewer_* triggers, so projects.reviewer_obs_count was 2x the real number of
-- observations (3 observations -> 6). 0032's triggers are canonical (they also maintain
-- reviewer_participant_count and reviewer_last_observed_at). The reviewer_participants_* side-table
-- triggers from 0022 write different tables and are not duplicates.
DROP TRIGGER IF EXISTS trg_reviewer_obs_project_count_insert;
DROP TRIGGER IF EXISTS trg_reviewer_obs_project_count_delete;
UPDATE projects SET reviewer_obs_count=(SELECT COUNT(*) FROM reviewer_observations o WHERE o.project_id=projects.id);
