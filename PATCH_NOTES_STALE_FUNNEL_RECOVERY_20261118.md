# Delegation Evidence Funnel 오래된 스냅샷 및 검증 지연 완화 (2026-11-18)

## 증상
- 표시 snapshot: Cycle 5 / Evidence r773 / 2026-10-03T09:17:27.782Z
- 현재 재검증: r4025 / 208개 후보 / Synthetic 21개 통과 / 나머지 레이어 N/A
- 오래된 값은 과거 아카이브이며 현재 r4025의 실제 검증 결과와 동일하지 않습니다.

## 코드에서 확인된 병목 및 수정
1. `advanceProject()`는 `compute_candidate`가 하나라도 진행 중이면 일찍 반환하므로 기존 배포에서 누락된 Historical/Stress 작업을 보충하지 못했습니다. 이제 다른 후보 탐색 중에도 확정 후보의 robust 작업을 예약합니다.
2. active 후보가 남아 있는 분기도 누락된 robust 작업을 예약하도록 수정했습니다. 탐색 완료를 기다리지 않습니다.
3. `enqueueRobustValidation()`의 기존 queued/running 작업 검사는 Evidence Revision을 확인하지 않아, 과거 r773의 작업이 현재 r4025의 Historical/Stress를 차단할 수 있었습니다. 이제 현재 Revision과 정확히 일치하는 작업만 중복으로 취급합니다.
4. robust gate의 사전 검사도 구버전 작업에 의해 막히지 않도록 현재 Revision 작업만 기준으로 검사하도록 조정했습니다.
5. 복구 목적으로 만드는 exploration 작업에도 현재 Revision을 명시해 재설계 후 오래된 작업이 잘못 수행되는 것을 차단합니다.

## 중요한 경계
- 새로운 검증 결과를 창작하거나, 과거 Revision에서 통과한 후보를 현재 Revision의 PASS로 재분류하지 않습니다.
- 연구주기 변경, 데이터/프로토콜 변경으로 인한 재검증은 의도된 동작일 수 있습니다.
- 운영 D1과 GitHub Actions의 실제 실행 이력은 직접 조회하지 못했습니다. 즉, 이번 패치만으로 모든 레이어 완료를 보증할 수 없습니다.
- Human은 현재 연구주기에 적합한 실제 참가자 기록이 필요합니다.

## 적용
- ZIP 안의 `src/lib/orchestrator.js`, `src/lib/compute.js`를 같은 경로에 덮어쓰고 Worker 및 Actions가 같은 커밋을 사용하도록 배포합니다.
- `tests/na_recovery.test.mjs`는 회귀 테스트를 포함합니다.
- D1 초기화나 마이그레이션은 필요 없습니다.

## 운영 D1 진단 SQL (Cloudflare D1 Console에서 읽기 전용)
아래 SQL은 해당 프로젝트가 단일 프로젝트인 경우에도 `projects`를 통해 확인하고, 여러 프로젝트라면 출력된 ID를 기준으로 필터링합니다.

```sql
SELECT id,name,status,current_stage,research_cycle,evidence_revision,updated_at,last_evidence_at FROM projects ORDER BY updated_at DESC LIMIT 10;

SELECT project_id,type,phase,status,COUNT(*) n,MIN(created_at) oldest,MAX(updated_at) newest
FROM jobs WHERE status IN ('queued','running','failed') GROUP BY project_id,type,phase,status ORDER BY n DESC LIMIT 80;

SELECT project_id,evidence_revision,phase,COUNT(DISTINCT candidate_id) candidate_count,MAX(created_at) newest
FROM simulation_runs WHERE phase IN ('confirmation','historical','stress') GROUP BY project_id,evidence_revision,phase ORDER BY evidence_revision DESC LIMIT 60;

SELECT project_id,research_cycle,evidence_revision,evidence_kind,source,COUNT(*) n,MAX(created_at) newest
FROM evidence_events GROUP BY project_id,research_cycle,evidence_revision,evidence_kind,source ORDER BY evidence_revision DESC LIMIT 50;
```

특히 `jobs`에 이전 Revision의 historical/stress 작업만 있고 현재 Revision 작업이 없으면 이번 패치의 주된 복구 대상입니다. `jobs`의 마지막 오류와 GitHub Actions 실패 여부가 심각한 실행 장애 원인을 알려줍니다.

## 로컬 검증
`npm test` : 310/310 통과 (2026-11-18 로컬 코드 환경)
