# DCV Matrix · Bojo connector patch (2026-11-18)

## Files to overwrite
- `src/lib/report.js`: rebuild legacy report Table 9B from D1-measured current-cycle candidate values; fixed eight-column Markdown row lengths; live official status handles partial pagination.
- `src/lib/thesis.js`: limits simulation run evidence to current research cycle AND evidence revision; candidate labels include additional design variables to distinguish otherwise identical labels.
- `src/lib/official_sources.js`: Bojo pagination stays partial until the final page; uses cumulative distinct persisted D1 observation coverage, resumes next page, resets pagination cursor after completion.
- `src/index.js`: live report GET replaces only Table 9B from latest current-cycle evidence when current saved report is valid; archived/stale report stays explicitly historical.
- `tests/report_live_matrix_refresh.test.mjs`: regression tests.

## Deployment
Apply the included paths to the existing project, keep existing D1 tables/data, deploy through the project's standard workflow. No SQL migration is needed. If Bojo currently has `partial:resume_next_page`, allow the scheduled collector or manual collection to finish pagination before expecting '수집 완료'. Ten stored rows alone do not establish completion when the upstream `totalCount` exceeds ten.

## Validation
298 / 299 project tests passed. The one failure concerns unrelated AI DOI/language validation, also present before these changes. No direct production D1 access or production deployment was performed.
