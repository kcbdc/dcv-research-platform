# DCV Delegation Evidence Funnel 수정 (2026-11-18)

- `validation_matrix.js`: 그룹 판정이 없는 stress 결과에서 scenario_scores(Adversarial/BIS/ECB)를 복구 계산. 저장된 D1의 현재 Cycle/Revision만 사용. 제약 수치 없는 시나리오는 HOLD 처리. 기존 캐시의 N/A도 조회 시 재평가.
- `public/app.js`: 검증층 전체가 N/A인 경우 생존 21처럼 표기하지 않고 — / 미검증 · 21 대기라고 표시. 다음 층의 관측 여부는 실제 이전 단계 생존 후보에서 판단.
- `thesis.js`: 미검증 게이트가 하나라도 있으면 final strict survivors=0, provisional_survivors 별도 기록. 보고서의 이월은 확정 검증 통과가 아님.
- `report.js`: N/A 단계가 이전 수를 이월하더라도 PASS가 아님을 명시.
- `tests/validation_matrix.test.mjs`: stress fallback, 근거 없는 PASS 방지 테스트 추가.

적용: 각 파일을 프로젝트 루트 동일 경로에 덮어쓴 뒤 배포. DB 초기화/마이그레이션 불필요.
현재 배포 운영 D1의 Historical, Human 평가 결과가 정말 미실행이라면 해당 단계는 재실행/재계산이 필요합니다.
원본 ZIP 및 앞선 Matrix/Bojo 변경 파일을 기초로 패치했습니다. 전체 테스트: 301건 중 300 통과, 1건은 기존 lab DOI/언어 검증 테스트 실패.
