# DCV Research Lab v0.7.11 — foundation snapshot refresh

## Root cause
The 10-person AI lab was not always reading the same live human-participant evidence as the report/API. Two independent behaviors kept an old `research_foundation` result alive:

1. `readLabSnapshot()` reused `lab_campaigns.snapshot_json` for up to 24 hours when the project counters had not changed. A code deployment that changed participant eligibility rules did not change the snapshot signature, so the pre-fix snapshot could still say `<30` participants.
2. Repeated `Blocked at research_foundation: ...` holds were handled like operational failures. After repeated retries the campaign could enter `attention`, while the scheduler only claimed `active` campaigns. That left the old `last_error` visible even after the underlying evidence logic had been fixed.

## Fix
- Bump the lab snapshot schema to `DCV-LAB-EVIDENCE-2` and include the schema in the snapshot signature. Old snapshots are therefore invalidated immediately after deployment.
- Cache reuse now requires both matching signature and matching snapshot schema.
- `GET /lab/review` refreshes an obsolete snapshot and persists the refreshed evidence digest before computing readiness.
- `research_foundation` HOLD is treated as an expected scientific hold rather than an operational error: it stays active, retries on a short interval, and does not increment the operational error counter.
- Campaigns previously stuck in `attention` specifically because of a `research_foundation` hold are self-healed back to `active` on the next scheduler tick. Unrelated operational `attention` states are left untouched.
- Human-participant query retains the v0.7.10 compatibility rule: current protocol + legacy untagged observations are eligible; explicitly incompatible protocols are excluded.

## Expected result after deploy
The next lab review/scheduler tick rebuilds the evidence snapshot. If the current human protocol has 80 eligible real participants, the `<30 participants` blocker disappears. Other independent blockers (correct/error strata, current-revision recomputation, independent full seed replay) remain until their own requirements are met.

## Verification
`node --test tests/lab.test.mjs`: 17/17 passed against the current main fixture with the v0.7.10 human eligibility logic preserved.
