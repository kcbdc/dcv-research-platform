# PATCH NOTES v0.8.6 — Realized Evidence, Threshold Sensitivity & Human Identity Controls

## 핵심 변경

1. **Doctoral HARD gate를 설정값이 아닌 실현값 기반으로 변경**
   - 실제 main_v2 유효 참가자·정답/오답 trial 수
   - 실제 cluster-bootstrap 판별력 Δ 95% CI 하한 ≥ 0.15
   - 후보별 실제 confirmation episode 수 ≥ 사전등록 confirmation_n
   - confirmation 결과 artifact에서 실제 `delay_mode=queue_v1` 사용 여부
   - 첫 simulation 이후 definition 변경 0건
   - 프로토콜 상태가 실제 `FROZEN`인지 확인

2. **제약 상한의 q90 자동적용 폐지**
   - prior-cycle quantile은 진단용으로만 유지
   - `GET /api/projects/:id/constraint-sensitivity` 추가
   - exploration/refinement의 broad candidate set에서 FN/FP/loss/review/recovery 상한 격자별 feasible share 곡선을 산출
   - `npm run constraints:sensitivity -- runs.csv [constraints.json]` 추가
   - 정책/규제/SLA/전문가 근거가 없는 단일 상한은 박사과정 gate에서 Advisory 처리

3. **후보 선택 단계의 이상적 검토자 제거**
   - 모든 phase에서 최신 적격 human reviewer model을 사용
   - 아직 적격 human model이 없으면 사전등록된 `preregistered_degraded_reviewer_v1` 조건 사용
   - 인간모형은 마지막 recompute 단계에만 투입되지 않음

4. **인간실험 신원·품질 통제 강화**
   - 관리자 발급 1회용 invite token 필수
   - `subject_key`는 서버에서 SHA-256 해시만 저장하여 cycle 간 동일 피험자 판별
   - 최초 요청 fingerprint(IP+User-Agent의 프로젝트별 해시)에 invite를 결속
   - 응답시간은 client 값이 아니라 trial.created_at ~ 서버 수신시각으로 계산하고 client 값은 대조용으로만 저장
   - 주의확인 3문항을 본 30 trial 사이에 deterministic-random interval로 삽입
   - 이해도 퀴즈를 3개 boolean → 5개 boolean로 강화

5. **재현 주장 범위 축소**
   - 보고서 표기를 `Independent Replication`에서 `Pre-registered Internal Holdout Resampling`으로 변경
   - 동일 엔진 내부 holdout 재표집은 외부 구현/외부 데이터 재현이 아님을 명시

## DB migration
- `0025_realized_rigor_human_invites.sql`

## 테스트
- 전체 `199 / 199 PASS`
- 신규 테스트: 실현값 기반 HARD gate, 전체요인 직교성 감사, 제약 민감도 곡선
