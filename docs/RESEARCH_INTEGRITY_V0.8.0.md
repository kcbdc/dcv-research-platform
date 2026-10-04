# Research integrity changes in v0.8.0

1. `balanced_factorial_v2`: estimator × alpha × W is a complete factorial within each nuisance block. Unevaluated candidates are never included in estimator pass-rate denominators.
2. `design_key`: SHA-256 of the scientific design vector is stored separately from the cycle-scoped candidate row id. This deliberately avoids reusing a primary key across research cycles, which would mix historical simulation records; lineage is compared by `design_key` instead.
3. Current-cycle reports include validation/candidate overlap diagnostics and flag validations attached only to superseded candidate sets.
4. d/K mechanism diagnostics are reported directly from stored confirmation/historical/stress runs rather than inferred from marginal candidate counts.
5. Robust/human recomputation queues support up to 500 candidates per pass.
6. `main_v2` human evidence excludes legacy observations, practice trials, attention checks, QC-failed trials, incomplete sessions, and excluded participants from the primary model while preserving all raw records.
