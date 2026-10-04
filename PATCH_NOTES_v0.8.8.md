# DCV Research Platform v0.8.8 — External-validity claim gate

## Purpose
Prevent contextual fiscal/subsidy data or same-engine holdout resampling from being overstated as external validation of real public-payment outcomes.

## Claim levels
1. `INTERNAL_COMPUTATIONAL`: simulation/model evidence only.
2. `CONTEXTUAL_PUBLIC_PAYMENT`: Case B or verified real public-payment context exists, but no labelled outcome validation.
3. `OUTCOME_VALIDATED_PUBLIC_PAYMENT`: verified actual public-payment records with explicit outcome ground truth and a SHA-256-attested PASS evaluation (n>=30).
4. `INDEPENDENT_EXTERNAL_REPLICATION`: level 3 plus independent data source and non-DCV implementation.

## New admin endpoints
- `GET /api/projects/:id/external-validity`
- `POST /api/projects/:id/external-validity/datasets`
- `POST /api/projects/:id/external-validity/evaluations`

Dataset registration requires a SHA-256 data hash and provenance. Outcome-labelled datasets also require an explicit `outcome_definition`. External evaluations require SHA-256 hashes for analysis code and result artifacts.

## Reporting/approval behavior
The generated report contains `6D. 외부 타당도·주장 범위 게이트`, and section 7A dynamically restricts claims. Computational/scientific approval may still exist for an internally valid study, but its `evidence_scope` cannot silently imply public-payment outcome validity.

## Database
Apply migration `0026_external_validity_claim_gate.sql`. Raw sensitive payment records are not stored by this registry; only dataset metadata, row counts, provenance, and cryptographic hashes are retained.

## Verification
`npm test`: 206/206 PASS. `node scripts/verify-migrations.mjs`: verified.
