# DCV fast evidence pipeline — 2026-11-18

## Goal
Persist per-candidate evidence promptly and begin eligible downstream evaluation without waiting for every other candidate to finish. No simulation, human validation, or official-data PASS is fabricated.

## Key changes
- `computeCandidate` records simulation_runs first (existing authoritative D1), then refreshes just the completed candidate's matrix row for confirmation/historical/stress.
- As soon as a candidate passes **confirmation**, Historical and Stress are queued independently. Validation/reviewer/approval still use the existing project-wide gates.
- Robust-validation batch enqueue skips already running/queued phases to avoid duplicate evaluations.
- Historical/Stress jobs now include evidence revision; the execution layer drops obsolete revision-scoped jobs instead of executing them in the latest research revision.
- Five-minute GitHub schedule fallback replaces the former 30-minute fallback. Event-based dispatch remains the primary wakeup. GitHub schedules are best effort, not guaranteed real-time.
- Per-candidate matrix refresh reads only that candidate's run/human evidence, reducing D1 pressure. A failed cache refresh is separately audited and the authoritative simulation result remains saved; GET can rebuild it.
- Includes prior fixes to Matrix, Funnel, report table 9B, BOJO collection status and revision-aware recovery in the changed-file set.

## How to apply
Copy the files from this archive into the repository root (preserve folders), commit, and deploy Worker and GitHub Actions from the same commit. Do not clear D1 or rerun migrations solely for this patch.

## Verify in production
1. Check GitHub Actions `DCV research compute` for scheduled/dispatch executions and successful D1 job writes.
2. Verify `jobs` for each confirmed candidate, `historical` / `stress` progress and errors.
3. Check `simulation_runs` has current `evidence_revision` rows and per-candidate Matrix status changes.
4. Refresh/reopen the report: table 9B should use current evidence. Actual missing BIS/ECB/Human evidence must remain N/A until validated.
5. If old **done** historical/stress jobs exist for an obsolete revision, the new payload-scoped jobs are not blocked; inspect failed jobs if no progress.

## Tests
`npm test`: 303/304 passed. The existing AI DOI/language validation test fails independently of this change.

## Notes / limits
- This is a code patch, not a live deployment or direct inspection of the production D1.
- A Synthetic PASS in the UI is not necessarily the same as a `confirmed_feasible` candidate; immediate downstream work begins after confirmatory evidence is stored.
- Human evidence must come from actual eligible human records; no synthetic substitution.
- Five-minute fallback can increase GitHub Actions minutes and D1 calls relative to 30-minute fallback.
