# DCV Research Platform v0.10.0

## Human trial pending recovery

- `complete_pending_practice_trial`이 사용자에게 그대로 노출되던 흐름을 제거했습니다.
- 참가자가 새 문항을 요청했을 때 현재 cycle/protocol에 `pending` trial이 있으면 새 trial을 만들지 않고 기존 trial을 다시 반환합니다.
- 비정상적으로 pending trial이 여러 개 존재하면 가장 최근 항목 하나만 유지하고 나머지는 `superseded`로 정리합니다.
- 재개 응답에는 `resumed_pending:true`가 포함되며 UI에서 “진행 중이던 연습문항/문항을 이어서 표시합니다.”라고 안내합니다.
- 인간실험 오류코드를 자연스러운 한국어 문구로 변환합니다.
- 기존 주실험/주의확인/서버 응답시간/QC 규칙은 유지합니다.

## Verification

- 신규 pending-practice 재개 회귀테스트 추가
- 전체 테스트: 235/235 PASS
