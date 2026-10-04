# DCV Doctoral Research Rigor Gate v0.8.4

v0.8.4 adds a machine-checkable doctoral-level rigor gate before computational confirmation.

Hard gates:
1. protocol frozen before the first simulation in the active research cycle;
2. nuisance-factor pairwise Cramer's V <= 0.05;
3. confirmation seed family does not overlap exploration/refinement seeds;
4. approval delay uses queue_v1 rather than additive legacy delay loss;
5. human protocol is main_v2 with preregistered minimum discrimination CI lower-bound target >= 0.15;
6. confirmation sample size is fixed at >=300 episodes.

Advisory checks additionally expose constraint provenance, prior-cycle calibration, robust phase coverage, orphan validation rows, and definition/protocol version counts as a forking-path ledger.

The gate is diagnostic, not a substitute for committee review, IRB/ethics review, subject-matter validation, or an independent replication.
