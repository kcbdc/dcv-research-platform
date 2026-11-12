# 연구실 마감 연장 + 재개 + 429 복구

## 원인
- 활동 중단: 10/2 Workers AI 429 → 15분 단위 재시도가 누적(error_count>=4) → 캠페인 status='attention' → 스케줄러는 'active'만 처리하므로 영구 정지.
- 마감(기본 2026-10-30)이 이미 지나, 단순 resume 시 다음 틱에서 바로 최종 패키지 생성·종료.

## 변경
- `src/lib/lab.js`
  - `POST|PUT /api/projects/:id/lab/deadline` `{ "deadline_at": "2026-11-30T14:59:59.000Z" }`
    마감 변경 + status=active + 오류/lease 초기화 + 남은 작업을 지금~새 마감까지 균등 재배치(starts_at 재계산). 검증: 1시간 이상 미래, 미완료 캠페인.
  - 429/용량/쿼터 오류는 30분 뒤 재시도, 시도 횟수 미소모, 'attention' 승격 없음.
- `src/lib/lab_policy.js`: DEFAULT_DEADLINE → 2026-11-30T14:59:59Z (11/30 23:59:59 KST).

## 배포 후
1. Cloudflare 변수 `LAB_DEADLINE_AT` 이 설정돼 있으면 `2026-11-30T14:59:59.000Z` 로 변경(또는 삭제).
2. 배포 후 위 API를 프로젝트 ID로 한 번 호출.
3. `COMPUTE_EXECUTOR` 가 hybrid/github-actions 이면 scheduleLab 은 `EXTERNAL_RUNTIME=github-actions` 일 때만 동작 → Actions 러너가 실제로 도는지 확인.
