# DCV Research Platform v0.8.5

This release adds an independent replication cycle suitable for a dissertation confirmation workflow. Replication can begin only after a source-cycle `SCIENTIFICALLY_APPROVED` decision and a passing doctoral-rigor HARD gate. The source candidate and analytical settings are frozen before the new cycle begins.

The replication cycle uses exactly one locked candidate and begins at confirmation, not exploration. It uses a separate deterministic seed namespace, a preregistered holdout scenario namespace for synthetic confirmation, reruns historical/stress validation, and rejects human participants who appeared in the source cycle. Source-cycle results are preserved and never overwritten.

A new `independent_replications` table records source/replication cycles, candidate identity, design key, source/replication protocol hashes, locked settings, seed/scenario salts, status and results. Reports include a dedicated independent-replication section and doctoral rigor adds replication lock, seed-disjointness, holdout-scenario and fresh-human-sample HARD checks.

Apply migration `0024_independent_replication_cycle.sql` before deployment.
