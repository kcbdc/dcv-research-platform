# v0.10.11 — 공식 데이터 커넥터 "Internal Server Error" 수정

## 원인
- `POST /api/projects/:id/official-sources/test` 라우트에 try/catch가 없어, `collectEcos` 내부 예외
  (JSON.parse 실패, 네트워크 오류, ECOS 오류코드 등)가 Worker 최상위로 전파 → plain-text `500 Internal Server Error`.
- 프론트 `api()`가 JSON 파싱 실패 시 `statusText`만 표시 → 실제 원인이 가려짐.
- ECOS 쪽: StatisticItemList를 1~10건만 조회 / 비JSON 응답 미처리 / 시크릿 앞뒤 공백·개행 미처리.

## 변경
- `src/lib/official_sources.js`: 안전 JSON 파서, ECOS RESULT 처리, HTTP/네트워크/타임아웃 오류 라벨링,
  시크릿 trim, StatisticItemList 1000건 조회, `explainConnectorError` / `testOfficialConnectorSafe`(예외 비발생),
  `officialSourceStatus`에 `last_error`(최근 동기화 오류 + 해결 힌트) 추가.
- `src/index.js`: test 라우트가 `testOfficialConnectorSafe` 사용 (항상 JSON 응답).
- `public/app.js`: `ok:false` 응답의 code/hint 표시, `api()`가 비JSON 오류 본문도 읽음, 상태 목록에 최근 오류 표시.
- `tests/official_sources.test.mjs`: 회귀 테스트 2건 추가.

# v0.10.11 (추가) — FDIC "실패은행 자동 매칭" 503 수정

## 원인
- `resolveFdicLinks`가 `failures` 전체(최대 2페이지×10,000행, 전 필드)를 받아 JSON 파싱한 뒤,
  81개 에피소드 × 수천 개 은행을 매번 정규식 정규화로 교차 스코어링(약 31만 쌍, 로컬 측정 CPU 약 1.1초).
  README 기준 Workers의 짧은 CPU 제한을 넘기면 Worker가 503으로 종료됨.
- 상대 서버(api.fdic.gov)의 일시적 5xx/429에 재시도·타임아웃이 없었고, 라우트 예외 처리도 없었음.

## 변경 (`src/lib/fdic.js`, `src/index.js`, `public/app.js`)
- `failures` 요청을 `fields=CERT,NAME,FAILDATE,CITYST`로 축소.
- 은행명을 1회만 정규화하고 토큰 역색인으로 후보만 스코어링(점수≥0.48은 공유 토큰 없이는 불가능하므로 결과 동일).
- `fdicRequest`: 25초 타임아웃, 429/5xx/네트워크 오류 최대 3회 재시도(백오프, Retry-After 존중).
- `explainFdicError`: 오류코드·힌트·retryable. resolve 라우트는 JSON(502/500)으로 응답, enable 라우트는 매칭 실패해도 소스 활성화는 유지.
- UI: 실패 사유와 힌트 표시.
- 테스트: `tests/v0111_fdic_resolve_resilience.test.mjs` 4건.

# v0.10.11 (추가) — 공식 데이터가 계속 QUEUED_OR_NOT_FETCHED 인 문제

## 원인
- `COMPUTE_EXECUTOR=hybrid`에서 `collect_project`는 GitHub Actions 전용(github-heavy) 작업. Worker는 가져가지 않음.
- Worker가 러너를 깨우려면 `GITHUB_ACTIONS_TOKEN` 필요(없으면 `not_configured`), 이후는 GitHub 30분 cron에 의존.
- 8분 후 Worker 비상 실행(`recoverHybridStall`)이 `EMERGENCY_WORKER_COMPUTE`를 설정하지만 이 플래그를 읽는 코드가 없어 아무것도 실행되지 않음.
- 수집 실패 시 `next_fetch_at`이 cadence(ECOS 1일, BIS 7일)만큼 밀려 재시도가 막힘.

## 변경
- `collectDueOfficialSources`: 공식 커넥터를 Worker에서 직접 수집(Actions 불필요). 수동 버튼은 force, cron은 5분마다 due 소스 2개.
- `POST /official-sources/collect`: 큐 등록과 함께 즉시 수집 후 소스별 결과(오류코드·힌트)를 반환.
- 수집 실패 시 재시도 간격을 최대 30분으로 단축.
- `claimJobs`: `EMERGENCY_WORKER_COMPUTE` 반영(collect_project 한정).
- 상태 응답에 `pipeline`(큐 대기 수, Actions 설정/러너 상태) 추가, UI에 대기 사유 표시.
- 테스트: `tests/v0111_official_inline_collect.test.mjs` 4건.
