# DCV 인간실험·검증 도표 보존 패치 (2026-10-16)

- 현행 Cycle/main_v2 주분석 완료 인원과 과거 Cycle/규약 완료 인원을 분리 표시. 과거 집계는 같은 사람이 서로 다른 연구주기에 있을 경우 중복될 수 있으며, 현행 32명 적격 판정으로 전환하지 않습니다.
- 그림 6 External Validation Matrix, 그림 7 Delegation Evidence Funnel: 현재 주기의 후보나 판정자료가 전혀 없으면 `candidate_validation_matrix`에서 가장 최근에 저장된 이전 주기의 유효 스냅샷을 읽어 표·그림의 데이터를 복원. 과거 Cycle/Revision과 시각을 표시하고 **현행 판정이 아님**을 경고합니다.
- 원본 기록에는 DELETE/UPDATE를 수행하지 않는 읽기 기반 수정입니다. D1 원격 DB에는 접속하지 않았으므로 실제 과거 적격 32명의 품질기준 충족 여부는 배포 후 D1 확인 필요.
- node --check 검사 세 파일 통과. 원본 저장소 전체 테스트 중 다수는 기존 fixture/migration 오류 `no such column: r.research_cycle`로 실패했으므로 배포 전 해당 문제 확인 필요.
- 먼저 Cloudflare D1 백업 → GitHub 코드 반영 → Actions 재배포 → 현재/과거 Cycle 숫자 및 그림 6·7의 `LAST_KNOWN_VALID_SNAPSHOT` 표시 확인을 권고.
