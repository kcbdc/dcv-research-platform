# DCV Research Platform v0.8.9

## Root cause fixed
The GitHub runner was correctly refusing to compute because the current executable inputs no longer matched an already-frozen protocol. Old builds retried each candidate job, eventually leaving pending candidates with only failed jobs, so UNEVALUATED could remain indefinitely.

## Recovery policy
A frozen cycle is never silently rewritten. On runtime-contract or protocol-integrity mismatch the old cycle and evidence remain immutable, queued/running compute work is superseded, and `registerEvidence(... force_new_cycle:true)` creates a new research cycle under the current protocol. This preserves scientific lineage while restoring forward progress.

## Runtime binding
Protocol schema is `DCV-PROTOCOL-1.3`, engine is `DCV-CDRS-v4`, and the frozen protocol now stores `execution_config`. Candidate computation reads this frozen snapshot instead of mutable live configuration.

## GitHub Actions
Protocol recovery is emitted as `job_protocol_recovery` and is not counted as a failed workflow. The next scheduled run continues define -> measure -> seed -> compute in the new cycle.
