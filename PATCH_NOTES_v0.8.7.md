# PATCH NOTES v0.8.7 — Runtime Attestation & Confirmatory GLMM Export

## 1. Frozen protocol → actual execution attestation
- `computeCandidate()` now retains the object returned by `assertProtocolIntegrity()`.
- Every newly written `simulation_runs.result_json` records `protocol_hash`, `protocol_definition_version`, and `protocol_attested_at_run=true`.
- The doctoral HARD gate adds `runtime_protocol_attestation`; every confirmation run must carry the exact current frozen protocol hash. Old confirmation artifacts without the attestation cannot satisfy the gate and must be regenerated in a new cycle.

## 2. Publication-grade human-model export
- Added `src/lib/glmm_export.js`.
- Admin endpoint: `GET /api/projects/:id/reviewer-glmm-package`.
- Exports only current-cycle, current-revision, QC-eligible `main_v2` main trials.
- Participant identifiers are server subject hashes when available, otherwise project-scoped SHA-256 pseudonyms.
- Output includes CSV, data SHA-256, metadata, and a reproducible R `lme4::glmer` script for `human_accept ~ ai_correct * confidence_z + (1|participant_id)`.
- This does not replace external statistical review; it makes the confirmatory analysis reproducible outside the platform.

## Tests
- 201 / 201 PASS.
- Added regression tests for runtime protocol attestation and the GLMM export schema.

## Migration
- None. All new attestation fields are stored in existing `result_json`.
