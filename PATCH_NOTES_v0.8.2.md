# DCV Research Platform v0.8.2

## 목적
v0.8.1의 승인 지연 큐(`queue_v1`)와 직교 균형설계(`orthogonal_balanced_v3`)를 기반으로, 남아 있던 인간실험 품질관리·인증·검토자 모형·제약 경계·레거시 입력·테스트 회귀 문제를 정리한 패치입니다.

## 주요 변경
- 기본 제약을 queue_v1 결과의 경계 탐색에 맞게 조정: FN 0.08, FP 0.055, 검토부담 0.30, 복구시간 2.5, 손실 0.18, 손실초과 0.10.
  - 이 값은 외부 정책 기준으로 확정된 값이 아니라 **탐색용 boundary target**입니다. 논문 확정 전 정책 근거 또는 사전등록 근거를 별도로 고정해야 합니다.
- 인간 검토 과제를 결정론적 금액/한도 계산에서 잡음 단서 기반 판단으로 변경.
- 본 trial 30개와 주의확인 3개를 분리. 본 trial은 신뢰도별 정확/오답 6/4로 균형.
- QC 기준을 설정에서 읽고 프로토콜 SHA-256을 실제 설정으로 계산.
- 관리자 API는 ADMIN_TOKEN 미설정 시 fail-closed. 참가자 경로는 별도 공개 경로 + 불투명 human session token으로 분리.
- trial_id 없는 신규 관측 입력 경로는 410으로 차단하고, 관리자 전용 legacy import만 `legacy_v1`로 허용.
- 검토자 모형에 신뢰도별 수용률, 참가자 이질성, penalized random-intercept logistic approximation을 추가하고, 판별력 CI 하한 최소효과 0.15 게이트 적용.
- 기존 legacy 894건은 원자료/누적 통계에 보존하되 primary human model에서는 제외.
- rebalance 시 v3 직교설계와 새 제약을 함께 적용.
- 죽은 `AUTO_APPROVE=true` 설정 제거.
- v0.8.0에서 남아 있던 핵심 회귀 테스트를 새 정책에 맞춰 정리.

## DB migration
`migrations/0023_human_public_auth_and_protocol_hash.sql`

## 검증
- `npm test`: 183 / 183 통과
- v0.8.1의 approval-delay queue 및 orthogonal design 회귀 테스트 포함

## 주의
운영 검토자 모형의 mixed-effects 부분은 플랫폼 내 빠른 게이트를 위한 MAP/penalized approximation입니다. 논문 확증 분석은 내보낸 원자료로 정식 GLMM을 별도로 수행하는 것이 적절합니다.
