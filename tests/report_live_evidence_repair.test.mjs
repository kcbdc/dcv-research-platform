import test from 'node:test';
import assert from 'node:assert/strict';
import {patchLiveOfficialTable,patchLiveHumanPool,patchLegacyMatrixLabels} from '../src/lib/report.js';
const old=`# Report\n\n**표 3E. 공식 외부데이터 연결현황**\n\n| Case | Connector | 역할 | 상태 | 관측행 | 기간 |\n|---|---|---|---|---|---|\n| A | bis_cpmi | digital_payments | not fetched | 0 | -~- |\n\n후속 절\n\n**표 9B. 대표 후보 External Validation Matrix**\n\n| 후보 | Historical | ECB |\n|---|---|---|\n| EMA | FAILED | N/A |\n\n> 해석: 주의\n`;
test('live official status overwrites stale table only, keeps following sections',()=>{
 const fixed=patchLiveOfficialTable(old,{sources:[{case_layer:'A',connector_id:'bis_cpmi',data_role:'digital_payments',readiness:'ok',coverage:{rows:39,first_period:'2012',last_period:'2024'}}]});
 assert.match(fixed,/bis_cpmi \| digital_payments \| 수집 완료 \| 39 \| 2012 ~ 2024/);
 assert.doesNotMatch(fixed,/not fetched/);
 assert.match(fixed,/후속 절/);
 assert.match(fixed,/\*\*표 9B/);
});
test('cached gateway error preserves measured row count and does not claim fresh success',()=>{
 const fixed=patchLiveOfficialTable(old,{sources:[{case_layer:'B',connector_id:'openfiscal',data_role:'public_fiscal_context',readiness:'degraded:upstream_unavailable',using_cached_data:true,coverage:{rows:9,first_period:'2026',last_period:'2026'}}]});
 assert.match(fixed,/이전 수집자료 유지 \| 9/);
 assert.doesNotMatch(fixed,/수집 완료 \| 9/);
});
test('legacy verdict strings become honest explanatory labels, not fabricated metrics',()=>{
 const fixed=patchLegacyMatrixLabels(old);
 assert.match(fixed,/미통과 · 수치 미기록/);
 assert.match(fixed,/미검증 · 수치 없음/);
 assert.match(fixed,/\*\*표 3E/);
});
test('human pooling is disclosed separately from quality gates',()=>{
 const fixed=patchLiveHumanPool('## 논문 사용 전 점검 사항\n\n- 기존 문장', {enabled:true,eligibility_status:'PASS',poolable_total:32,required_participants:32,prior_included:31});
 assert.match(fixed,/32명 \/ 기준 32명 \(참가자 수 기준 충족\)/);
 assert.match(fixed,/품질·판별력 및 Human 재계산 통과 여부는 별도 검증/);
});
