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

## 추가 (hybrid 모드에서 연구실이 안 도는 문제)
- 원인: wrangler.jsonc 의 COMPUTE_EXECUTOR=hybrid 이고 EXTERNAL_RUNTIME 이 없어서, Worker 크론의 scheduleLab() 이 매분 `waiting_for_github_actions` 만 반환하고 종료.
- `LAB_RUN_ON_WORKER=true` 이면 Worker 크론이 직접 연구실 작업을 실행(opt-in). wrangler.jsonc 에 설정 추가, LAB_DEADLINE_AT 을 2026-11-30T14:59:59Z 로 변경.

## 추가 (lab_ai_timeout)
- 자료작성자(writer)/리더는 max_tokens 4500 의 70B 생성이라 45초 타임아웃에 걸림 → 기본 120초(그 외 60초), `LAB_AI_TIMEOUT_MS` 로 조정(30~150초). 임대(lease) 시간 180s→240s.

## 추가 (Unverified DOI cited)
- 모델이 검증 목록(lab_sources)에 없는 DOI를 인용하면 작업 전체를 실패시키던 동작을 변경: 모든 문자열 필드에서 해당 인용을 제거하고 blockers 에 "Unverified DOI cited by the model was removed: …"(DOI 는 `[/]` 로 무해화) 로 기록. 미검증 DOI 는 문서에 남지 않음.
- 'Writer section is incomplete'(markdown 80단어 미만) 검증은 그대로 유지.
