# DCV External Validation Matrix · Human 열 N/A 해소 + FAIL 점검 (2026-11-18)

## 원인
`human_recompute` 판정은 **robust 검증을 CONFIRM한 후보에만** 생성되었다(`recompute.js`).
그런데 robust CONFIRM은 Synthetic·Historical·Stress를 모두 통과해야 하므로, BIS/ECB가 HOLD·FAIL이면 어떤 후보도
Human 단계에 도달하지 못했고 Matrix Human 열 192개가 전부 N/A였다. Overall도 6개 열이 모두 PASS여야 PASS이므로
Human이 N/A이면 구조적으로 PASS가 나올 수 없었다.

## 변경
- `src/lib/recompute.js`: Human reviewer 재계산 대상을 `confirmed_feasible`(Synthetic 확정) 후보 전체로 확대.
  robust CONFIRM 후보 → 기존대로 `human_recompute`(승인 근거). 그 외 → 표시 전용 `human_screen`.
  **승인(approve) 경로는 `human_recompute`만 읽으므로 robust 탈락 후보가 승인될 수 없다.** finalize는 멱등.
- `src/lib/orchestrator.js`: recompute/finalize 완료 판정을 `confirmed_feasible` 수 기준으로 변경(`human_screen` 포함 집계).
- `src/lib/validation_matrix.js`
  - Human: `human_recompute` 우선, 없으면 `human_screen`. 둘 다 없고 Synthetic이 PASS면 **HOLD**
    (`detail.human.reason` = `HUMAN_REVIEWER_MODEL_PENDING` | `HUMAN_RECOMPUTE_PENDING`). Synthetic 미통과 후보는 NA 유지.
  - **FAIL 점검 결과 수정**: 그룹 판정(`validation_groups.*.classification`)이 phase 단위 non-inferiority(K0 대비)
    계약을 무시하던 문제를 수정(`withNoninferiority`). Synthetic/Historical은 FAIL/HOLD가 그대로 반영되고,
    Stress 하위그룹(Adversarial/BIS/ECB)은 합산 대비라 귀속이 불가능하므로 PASS를 HOLD로만 낮춘다(FAIL 생성 안 함).
  - 이전 규칙으로 캐시된 행은 `rules_version`이 없으면 조회 시 1회 자동 재계산.
- `src/lib/thesis.js`: 리포트/Funnel도 동일 규칙 적용(Human screen·pending, non-inferiority). Human 지표를
  `result.metrics.*`에서 읽도록 수정(기존에는 최상위 키를 읽어 항상 null).
- `tests/human_matrix_screen.test.mjs`(신규 6건), `tests/validation_matrix.test.mjs`(1건 기대값 갱신).

## 적용
파일을 같은 경로에 덮어쓰고 배포. **DB 마이그레이션 불필요**(validation_type은 자유 텍스트).
배포 후 Matrix 조회 시 캐시가 자동 재계산되어 Human이 HOLD로 바뀐다.
reviewer 모델(인간 참가자 표본)이 이미 적합되어 있으면 advance 사이클이 recompute→finalize를 돌려 PASS/HOLD/FAIL로 채운다.
reviewer 모델이 없으면 Human은 HOLD(사유: 모델 대기)로 남는다 — 이는 인간 참가자 데이터가 부족하다는 사실의 표시이며,
degraded reviewer 시뮬레이션 결과를 Human PASS로 위장하지 않는다.

## 검증
332개 중 331 통과. 실패 1건은 변경 이전부터 실패하던 `event-driven hybrid … 5-minute recovery fallback`(무관).
운영 D1 접근·배포는 수행하지 않았다.
