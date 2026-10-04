# Independent replication cycle v0.8.5

A replication cycle can start only after the source cycle has both a scientific sign-off and all doctoral HARD gates passing. The selected design vector, constraints, benchmark, validation settings, source protocol hash, replication sample size, seed namespace and scenario namespace are locked before any replication simulation begins.

The replication cycle evaluates exactly one locked candidate. It skips exploratory selection and starts at confirmation with a new deterministic seed namespace. Confirmation scenarios use a preregistered deterministic holdout perturbation namespace. Historical and stress validation are then rerun. Human evidence must come from participants who did not appear in the source cycle; prior participants are rejected at the understanding-quiz/session entry point.

The source result is never overwritten. The new cycle receives a new frozen protocol hash and is reported separately in `independent_replications`. A successful computational replication does not itself constitute scientific approval; PI/committee sign-off remains separate.
