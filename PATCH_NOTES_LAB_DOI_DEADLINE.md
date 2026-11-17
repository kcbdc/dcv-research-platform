# DCV Research Lab: DOI verification and deadline display patch (2026-11-18)

Apply the files to their same relative paths in the project, then deploy the Worker and public assets together.

## Changes
- `public/lab.js`: 6-deliverables panel reads campaign.deadline_at (the same server-backed deadline shown in the header). Korean display uses Asia/Seoul and tracks deadline extensions. Missing/invalid deadline falls back to "연구 완료 후".
- `src/lib/lab_policy.js`: unknown DOI markers and bare DOI references in model-provided content are quarantined before validation; they do not create a fatal error or count as verified. Approved lab_sources references remain unchanged. Records a generic blocker, never silently approves unknown citations.
- `src/lib/lab.js`: resumes unfinished campaigns stuck in attention specifically due to legacy DOI errors, resetting attempts for only the current pending task. Existing completed/failed documents and source metadata are not touched.
- `tests/lab.test.mjs`: regressions for DOI citation, recovery, and dynamic deadline display.

## Verification
- node --test tests/lab.test.mjs: 19/19 passed.
- npm test: 306/306 passed in local source test environment.
- No D1 schema changes or migrations.

## Scope and caveat
This package does NOT automatically add any publisher DOI to lab_sources or assert it supports the project's specific scientific claims. If a citation is needed, verify it and import source metadata through the existing literature collection process. Existing failed task records from earlier campaign runs are not rewritten. The application must be redeployed, and the scheduler run, before the operator can verify operational recovery.
