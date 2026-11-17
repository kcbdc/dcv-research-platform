# 그림 7 Delegation Evidence Funnel — 빠른 단계 전환 패치

## 변경 파일
- `src/lib/db.js`: Hybrid GitHub runner 작업 선택에서 이미 검증 후보로 확정된 Historical·Stress 실행을 exploration backlog보다 우선 처리. confirmation/refinement도 그다음 처리. 기존 단독 github-actions 실행 우선순위는 유지.
- `src/lib/orchestrator.js`: 후보·검증 작업 완료 뒤 `advance_project` 재예약에 있던 인위적인 5초 지연 제거. (GitHub runner에서는 이미 대기 중인 compute 작업이 먼저 실행될 수 있음.)
- `public/app.js`: Figure 7/Matrix가 열린 브라우저 탭에서는 20초 간격으로 읽기 전용 API 재조회; 숨겨진 탭이나 화면에 없는 경우 재조회하지 않음.
- `tests/funnel_fast_stage_order.test.mjs`: hybrid 우선순위 및 기존 단독 실행 모드 회귀 테스트.

## 적용
프로젝트 루트에 동일 경로로 파일 덮어쓰기 → GitHub commit → Worker + Actions 동일 버전 배포.
DB 삭제/초기화나 migration 불필요.

## 한계 및 주의
- 우선순위 변경은 실제 `compute_candidate` 작업이 이미 큐에 있을 때 대기 시간을 줄입니다. 아직 실행되지 않은 검증, 누락 원자료, API 오류, D1 쓰기 실패를 PASS로 바꾸지 않습니다.
- 화면의 20초 폴링은 시각화 갱신일 뿐, 계산 작업을 새로 시작시키지는 않습니다.
- Actions runner 동시 실행/Cloudflare 예산 제한과 현재 설정된 5분 Cron 제한은 그대로입니다. GitHub 이벤트 디스패치가 구성돼 있다면 더 빨리 실행될 수 있습니다.
- 운영 Cloudflare D1 / GitHub Actions를 직접 확인하거나 배포하지 않았으므로 실운영 완료 여부는 별도 확인이 필요합니다.

## 검증
`npm test`: 308/308 PASS (로컬 fixture 기반)
