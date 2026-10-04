# v0.9.5 — Chart Safe Area + D1/Lab Read Guard

- 모바일 위임가능영역 canvas 하단 safe-area 확대: X축 `정보오차` 라벨 클리핑 제거.
- 10인 AI 연구실 snapshot signature에서 `projects.updated_at` 제거. 연구와 무관한 metadata 변경으로 대형 snapshot을 재생성하지 않음.
- lab snapshot 후보 예시는 40행, simulation 예시는 240행으로 제한하고 전체 합계는 `project_cycle_stats`에서 읽음.
- 인간 QC 집계를 correlated subquery에서 1회 participant aggregate CTE로 변경.
- 연구실 상태 polling은 120초로 완화하고 ETag가 같으면 campaign 1행 probe 후 즉시 304.
- 리더 책상 review snapshot은 매 poll마다 자동 조회하지 않고 사용자가 책상을 클릭할 때만 갱신.
- simulation/lab task hot-path 인덱스 추가 (`0029_lab_d1_read_guard.sql`).
- full-seed replay 검증은 bounded sample 행 수가 아닌 materialized `simulation_total`을 기준으로 확인.
