# DCV Research Platform v0.8.3 — constraint calibration + auth separation hardening

## 1. Prior-cycle quantile calibration

- Added `src/lib/constraint_calibration.js`.
- Added `npm run constraints:quantiles -- simulation_runs.csv --q=0.90`.
- Uses only `confirmation`, `historical`, and `stress` run summaries by default.
- Reports min / q50 / q75 / q90 / q95 / max for loss mean, loss exceedance, FP, FN, review burden, and recovery time.
- Proposed upper bounds are explicitly marked **exploratory** and may only be applied from a **prior research cycle**.
- Admin endpoints:
  - `GET /api/projects/:id/constraint-calibration` previews the immediately prior cycle.
  - `POST /api/projects/:id/constraint-calibration` freezes the selected prior-cycle quantile proposal into a new evidence/research cycle.
- A cycle-1 project returns `409 no_prior_cycle_for_constraint_calibration`, preventing same-cycle post-hoc threshold tuning.

## 2. Constraint plumbing fixes

Two pre-existing inconsistencies were found while integrating the calibration path:

1. `registerEvidence(...config_update...)` did not persist `constraints_json`; threshold changes passed by redesign code were therefore not guaranteed to reach `project_config`. v0.8.3 updates design, constraints, benchmark, and validation together.
2. The simulation classifier checked `loss_mean_max`, while the platform configuration/report used `loss_max`. v0.8.3 treats `loss_max` as the canonical key, retaining `loss_mean_max` only as backward-compatible fallback.

Threshold changes are evidence-changing events and invalidate old approvals/reports as before.

## 3. Participant/admin authentication separation

- Added explicit route classification: public health, public human bootstrap, human-session routes, and admin routes.
- Every API route not explicitly classified as participant-facing remains admin-only.
- `ADMIN_TOKEN` remains fail-closed (`503`) when missing.
- Participant trial/observation endpoints accept the human session only through `x-human-session`; an admin bearer token or body field cannot substitute for a human-study session.
- Admin and human-session comparisons use the same length-independent comparison helper.
- Legacy reviewer observation import remains admin-only.

## 4. Tests

- Added v0.8.3 constraint/auth regression tests.
- Full suite: **188 / 188 passed, 0 failed**.
