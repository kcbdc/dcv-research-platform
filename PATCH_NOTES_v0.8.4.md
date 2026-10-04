# v0.8.4 Doctoral rigor upgrade

- Added `src/lib/doctoral_rigor.js` with machine-checkable doctoral rigor gates.
- Computational confirmation is blocked until all HARD gates pass.
- Added `/api/projects/:id/doctoral-rigor` admin endpoint.
- Added report section `6B. 박사과정 연구엄밀성 게이트`.
- Checks protocol timing, nuisance orthogonality, confirmation seed independence, queue-based approval delay, preregistered human effect-size threshold, and fixed confirmatory sample size.
- Advisory diagnostics expose constraint provenance, prior-cycle calibration, robust phase completeness, candidate-validation orphan rows, and forking-path version counts.
