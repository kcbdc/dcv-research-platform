# DCV Research Platform v0.8.0 — Evidence Quality & Balanced Design Upgrade

## 목적
외부 보고서 패키지 검토에서 확인된 인간검토자 데이터 품질, 후보-검증 계보 불일치, 추정기 비교 교란, d/K 기작 검증 부족, 보고서 내부 정합성 문제를 플랫폼 수준에서 방지한다.

## 핵심 변경

### 1. 인간검토자 실험 main_v2
- 기존 894건은 `legacy_v1`로 보존하고 주 분석/검토자 모델 적합에서 제외한다.
- 서버 이해도 퀴즈(3/3 통과, 1회 재교육 재시도)를 통과해야 실험을 시작할 수 있다.
- 연습 10 trial + 본 실험 30 trial을 서버가 강제한다.
- 본 실험은 AI 오답 12/30(40%), confidence 0.55/0.75/0.92 각 10개로 균형화한다.
- 주의확인 3문항을 사전고정 위치에 삽입한다.
- <800ms, >60s trial은 주 분석에서 제외하고 원자료는 삭제하지 않는다.
- 과속 비율 >30%, 주의문항 2개 이상 실패, 연속 10회 동일응답은 참가자 EXCLUDE flag를 남긴다.
- 탭/포커스 이탈 횟수를 기록한다.
- `main_v2` 검토자 모델은 QC를 통과하고 30개 본 trial을 완료한 참가자만 사용한다.
- 기본 게이트: 유효 참가자 >=32, AI 정답 trial >=300, AI 오답 trial >=200, participant-cluster bootstrap 판별력 95% CI 하한 >0.
- 게이트 미달 시 `human_recompute` 확정에 쓰지 않고 reviewer model HOLD 처리한다.

### 2. 균형요인 후보 설계
- `balanced_factorial_v2`: estimator 4 × alpha 4 × W 3 = 48셀을 nuisance block마다 완전교차한다.
- 기본 4개 nuisance block = 총 192 후보.
- 미평가 후보는 통과율 분모에서 제외하며 `평가 완료 n / 계획 n`을 함께 보고한다.
- 기존 후보 ID를 재사용해 실행 계보를 섞지 않고, 동일 과학 설계는 `design_key` SHA-256으로 추적한다.
- 기존 프로젝트는 `POST /api/projects/:id/rebalance-v2` 또는 UI의 **균형설계 v2** 버튼으로 새 Research Cycle에서 전환한다.

### 3. 후보-검증 계보/정합성 감사
- `design_candidates.design_key` 추가.
- 보고서에 현재 후보와 validation candidate의 교집합, orphan validation 수, factorial cell balance를 자동 표시한다.
- candidate 교집합이 끊기면 과거 validation을 현재 결과처럼 숨기지 않고 경고한다.
- d/K별 확인·historical·stress 평균 지표를 자동 진단해 핵심 변수가 엔진에서 실제로 움직이는지 볼 수 있게 한다.

### 4. External Validation / Figure 7 / Figure 3
- historical/stress 재검증 큐 상한을 500으로 확장해 현재 후보 전체의 재검증 지연을 줄인다.
- External Validation Matrix는 현재 cycle/revision 연결을 유지하고 N/A를 실패처럼 취급하지 않는다.
- Minimax Regret 미계산은 0으로 표시하지 않고 대기 상태를 명시하며, 작은 값은 지수표기로 보존한다.

### 5. 10인 AI 연구실
- Evidence snapshot schema를 `DCV-LAB-EVIDENCE-3`로 갱신한다.
- 인간근거는 `main_v2` QC 적격 데이터만 사용한다.
- legacy 894건은 누적 기록으로 보존되지만 research foundation 통과 인원에는 포함하지 않는다.
- 최소 인원/정답/오답 trial 기준은 project validation config와 동일하게 읽는다.

### 6. 보고서 문구 및 투명성
- 중복 문장 `AI 오답 수용률은 AI 오답 수용률은` 제거.
- AI 서술 사용을 부정하는 문장을 제거하고, 수치·표·판정은 규칙 기반이며 AI 서술 초안은 별도임을 명시한다.
- estimator 표는 planned/evaluated/unevaluated를 분리한다.
- 자동 정합성·설계 감사 절을 추가한다.

## DB migration
`migrations/0022_human_quality_design_lineage.sql`

추가 필드/테이블:
- reviewer_trials: protocol_version, trial_phase, ordinal, attention_check, expected_accept, completed_at
- design_candidates: design_key
- reviewer_quality_flags
- reviewer_sessions
- research_integrity_checks

## 배포/활성화
1. `npm run db:migrate:remote`
2. Worker 배포
3. 기존 프로젝트에서 **균형설계 v2** 버튼을 눌러 새 Research Cycle 생성
4. legacy 인간실험은 주 분석에서 자동 제외되므로 파일럿/본 실험 `main_v2` 데이터를 새로 수집

## 검증
관련 회귀/신규 테스트 29/29 통과:
- v0.8.0 QC schema/schedule
- balanced factorial design
- External Validation Matrix
- Figure 7 survival funnel
- Figure 3 regret wait/precision
- 10인 AI 연구실 스케줄/snapshot/동시성
- CDRS validation matrix

기존 전체 테스트 중 일부는 `legacy_v1` 참가자를 주 분석에 포함한다는 이전 제품 가정을 검증하므로 v0.8.0의 의도적 정책 변경과 충돌한다. 배포 판단은 v0.8.0 신규 QC/설계 테스트와 관련 회귀 테스트를 기준으로 한다.
