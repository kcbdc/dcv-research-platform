# DCV 데이터 무결성 우선 성능 점검 · 2026-11-18

## 적용 전 중요 사항
이 패치는 **앞서 제공된 D1 429 대응 패치까지 적용된 코드베이스**(`/mnt/data/dcv_rate_work`, v0.10.13 기반 누적 수정본)를 기준으로 합니다. 오래된 원본 소스에 개별 덮어쓰기로 적용하면 다른 수정이 빠질 수 있습니다. GitHub의 현재 버전과 반드시 diff 후 병합하세요.

## 확인된 병목 및 정확성 결함
1. `computeCandidate`에서 historical/stress 고유 ID가 Evidence Revision과 무관해, 이전 Revision의 `INSERT OR IGNORE` 데이터가 현재 Revision의 실제 저장을 막을 수 있었습니다. 실제 검증이 안 된 현재 Rev에서 N/A가 반복되는 핵심 가능 원인입니다.
2. `validateProject`가 과거 Revision의 Historical/Stress 결과를 재사용해서 현재 Revision을 CONFIRM할 수 있었습니다.
3. `computeRegretTable`에서 과거 Revision 시뮬레이션을 포함한 후회값 계산 가능성이 있었습니다.
4. `approveProject`가 현재 Revision과 무관한 robust validation 기록을 조회할 수 있었습니다.
5. `bestConfirmedCandidate`가 현재 연구 주기/Revision과 관계없이 과거 CONFIRM 후보를 반환할 수 있었습니다.
6. `enqueueRobustValidation`에서 저장된 전체 Historical/Stress 결과를 별도 조회하던 경로를 제거하고, 인덱스를 이용하는 후보별 NOT EXISTS 판정 1회 + 현재 실행 중 작업 조회 1회로 대체했습니다. 예약을 위한 D1 왕복을 3→2회로 줄였습니다. 조회 실제 비용은 데이터 크기와 인덱스에 따라 달라집니다.

## 데이터 보존·판정 안전장치
- 기존 simulation_runs / candidate_evidence 행을 **삭제하거나 변경하지 않습니다**.
- 기존 frozen protocol의 exploration/confirmation ID는 유지합니다.
- Historical/Stress/Recompute만 `rev_<evidence_revision>` 접미사를 사용합니다. 해당 Revision에 완료한 작업을 다시 수행할 때 동일 ID를 재사용합니다.
- 이전 Revision 결과는 연구 이력으로 보존하되 현재 Revision의 Historical/Stress/Regret/승인 판정에 재사용하지 않습니다.
- 실제 검증 결과가 없는 후보는 HOLD/NA로 남습니다. 성능 개선을 위해 PASS 조건을 완화하지 않습니다.
- 스키마 마이그레이션·DB 초기화가 필요 없습니다.

## 배포 및 확인
1. GitHub 현재 소스와 파일 3개(`src/lib/compute.js`, `src/lib/validate.js`, `src/lib/approve.js`)를 비교·병합합니다. 테스트 파일(`tests/revision_compute_identity.test.mjs`)을 추가합니다.
2. `node --test tests/revision_compute_identity.test.mjs`와 `npm test`를 실행합니다.
3. Worker와 Actions runner를 동일 커밋으로 배포합니다. 수정 파일을 적용해도 실제 동작을 확인하기 전에는 운영 장애가 해결됐다고 단정할 수 없습니다.
4. 운영 D1 백업 후 Revision별 `simulation_runs`의 historical/stress 행이 생성되는지, `candidate_validation_matrix`의 current revision과 일치하는지 확인합니다.
5. D1 429가 계속되면 GitHub Actions 로그의 `d1_api_calls`, `d1_rows_read`를 확인하고 기존 호출 제한 패치를 유지합니다.

## 테스트 결과
- 신규 데이터 무결성 회귀 4/4 통과.
- 전체 `npm test`: 319개 중 318개 통과, 기존 `tests/lab.test.mjs`의 영문 제거 안내 문구 기대값 1건 불일치(이번 변경과 무관).
- 운영 Cloudflare D1 실측 및 실 서비스 재현은 수행하지 않았습니다.

## 후속 점검 권고
- 현재 r4025가 매우 자주 증가하는 원인이 실제 External Evidence 변경인지, 빈 값의 반복 기록인지 D1 이벤트 테이블에서 점검.
- 지나치게 빈번한 보고서 재생성을 막기 위해 데이터 변경시각과 생성시각을 비교; 근거 없이는 기존 자료 삭제/재시드 금지.
- GitHub Actions, Cloudflare 제한에 따른 처리량은 실제 운영 트래픽에서 확인 후 조절.
