# v0.9.2 — D1 Free-tier read optimization

## 원인
운영 경로에 이미 `project_cycle_stats` 조회가 있었지만 실제 테이블이 없어 매번 예외 후 `design_candidates` + `simulation_runs` 집계로 fallback 하고 있었습니다. 또한 GitHub Actions fallback cron이 5분 주기였고, 계산이 진행되는 동안 최신 simulation마다 draft report를 다시 만들 수 있어 대형 thesis/report 집계가 반복될 수 있었습니다.

## 변경
- `project_cycle_stats`를 실제 테이블 + 증분 trigger로 구현. 후보/시뮬레이션 dashboard 집계를 O(1) 조회로 전환.
- `scheduleAll`/`advanceProject`가 대형 후보 테이블을 반복 집계하지 않고 materialized stats를 사용.
- heavy compute/validation/recompute가 실행 중일 때 자동 draft report 재생성을 보류하여 대형 report/thesis 재집계를 coalesce.
- GitHub Actions cron fallback을 5분 → 15분으로 완화. 정상 heavy job은 event dispatch가 즉시 깨우므로 cron은 안전망 역할만 수행.
- 후보 regret, simulation phase, reviewer QC 경로에 covering/expression index 추가.
- Actions REST adapter가 Cloudflare 응답의 `meta.rows_read`를 누적하여 `d1_rows_read` telemetry를 로그에 표시.
- `npm run db:profile` 추가.
- migration: `0027_d1_free_tier_read_guard.sql`.

## 로컬 read-profiler 비교
동일 fixture(400 human observations, 96 candidates, 374 simulation runs)의 24시간 96 tick 추정치에서 `rows_read_estimate`가 **12,000 → 2,880 (약 76% 감소)**했습니다. 실제 workflow fallback도 288회/일(5분)에서 96회/일(15분)로 줄기 때문에, steady-state scheduler 부분은 단순 환산 기준 약 **92% 감소**합니다. 이는 Cloudflare 청구값 자체가 아니라 저장소의 EXPLAIN 기반 추정치이며, v0.9.2부터 Actions 로그의 `d1_rows_read`로 실제 원격 값을 확인할 수 있습니다.

## 배포
`npm run db:migrate:remote` 실행 후 Worker/GitHub 코드를 함께 배포하십시오. migration backfill은 최초 1회 기존 후보/실행 테이블을 읽습니다.
