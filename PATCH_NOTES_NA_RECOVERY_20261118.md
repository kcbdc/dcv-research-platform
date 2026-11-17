# DCV N/A 후속검증 자동복구 패치 (2026-11-18)

## 확인된 원인
- 현재 연구주기에 Synthetic PASS 21개가 존재해도 Historical/Stress 검증 실행이 생성되지 않으면 나머지 관문은 N/A로 유지됨.
- enqueueRobustValidation()은 기존 historical/stress 실행을 evidence_revision 조건 없이 완료로 간주해, 구 버전 실험이 새 Revision 작업을 차단할 수 있었음.
- advanceProject()의 robust 완료 수 집계 역시 Revision 구분이 없었음.
- scheduleAll()은 complete/report_ready 프로젝트를 정기 계산에서 제외해 누락 검증을 자동 재개하지 못했음.

## 적용
기존 프로젝트의 동일 경로에 변경 파일을 덮어쓴 후 재배포하세요. DB 초기화 및 신규 마이그레이션 불필요.
- src/lib/compute.js
- src/lib/orchestrator.js
- tests/na_recovery.test.mjs (추가)

## 주의
이는 자동 작업 생성/재개 패치입니다. Historical/Adversarial/BIS/ECB의 상태는 GitHub Actions/Workers가 실제 연산을 완료하고 D1에 결과를 기록한 후에야 N/A에서 변경됩니다. Human은 인간 검증 기록이 현재 Evidence Revision에 있어야만 판정할 수 있고 자동 PASS 처리하지 않습니다.
운영 D1 미접속·운영 서버 미배포 상태에서 코드 및 회귀 테스트를 검증했습니다.
전체 303건 중 302건 통과, 별도 DOI/언어 검증 테스트 1건 실패.
