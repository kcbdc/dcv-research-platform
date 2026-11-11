# v0.10.10 — External Validation Matrix 가 Adversarial 에서 멈추고 robust 단계를 무한 반복하던 문제

## 원인
마이그레이션 0027/0028/0033 은 자기 이름의 트리거(`trg_cycle_stats_*`)만 DROP 하고, 0022 의 `trg_candidate_stats_*`,
0023 의 `trg_sim_stats_insert` 는 삭제하지 않았다. 결과적으로 `design_candidates`/`simulation_runs` 변경마다
`project_cycle_stats` 가 **두 번** 갱신되어 `candidate_total`, `candidate_feasible`, `simulation_*` 가 실제의 2배가 되었다.

`advanceProject` 는 `(distinct stress 실행 수) < candidate_feasible` 이면 robust 단계에 머문다.
feasible 이 2배이므로 이 조건이 영원히 참 → `validate_project` 가 큐에 들어가지 않음 → 매트릭스 갱신(BIS/ECB),
Human 검토 단계에 도달하지 못함. (0033 은 카운터를 재빌드했지만 옛 트리거가 남아 즉시 다시 2배로 드리프트)

같은 계열: `reviewer_obs_count` 도 0022 `trg_reviewer_obs_project_count_*` 와 0032 `trg_projects_reviewer_*` 가 중복.

## 수정
- `migrations/0034_drop_legacy_cycle_stats_triggers.sql`: 중복 트리거 제거 + `project_cycle_stats`/`reviewer_obs_count` 재계산.
- `src/lib/orchestrator.js`: robust 게이트에서 권위 테이블 기준으로 실제 누락 작업이 0개인데 카운터가 부족하다고 말하면
  카운터를 복구(`cycle_stats.repaired` 감사로그)하고 다음 단계로 진행. 마이그레이션 적용 전/후 어느 쪽이든 루프에 갇히지 않음.
- `tests/helpers/d1shim.mjs`: 운영 D1 과 동일하게 `simulation_runs.research_cycle` 을 0022 직전에 보강(저장소 0001 에는 없어 신규 DB 에서 마이그레이션 체인이 깨짐).
- `tests/v0110_cycle_stats_duplicate_triggers.test.mjs`: 회귀 테스트 5개.
