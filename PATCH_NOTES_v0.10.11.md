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
