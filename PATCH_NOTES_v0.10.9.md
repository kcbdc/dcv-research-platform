# DCV Research Platform v0.10.9 — Non-negative cycle statistics repair

`UNEVALUATED` is a count and can never be negative. A legacy/drifted `project_cycle_stats.candidate_pending` cache could become negative because the UPDATE trigger did not clamp counters. Migration 0033 rebuilds the derived cache from `design_candidates` and `simulation_runs`, then recreates triggers with non-negative guards. The API and UI also clamp defensively.
