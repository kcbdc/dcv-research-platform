import test from 'node:test';
import assert from 'node:assert/strict';
import {patchLiveMatrixTable,patchLiveOfficialTable} from '../src/lib/report.js';
test('replaces legacy 9B verdicts with measured values and preserves adjacent sections',()=>{
 const md='**표 9B. 대표 후보 External Validation Matrix (상위 20행)**\n\n| 후보 | Historical | Synthetic | Adversarial | BIS | ECB | Human | Score |\n|---|---|---|---|---|---|---|---|\n| EMA | 미통과 · 수치 미기록 | 통과 · 수치 미기록 | - | - | - | - | 2/3 |\n\n### 다음 절\n';
 const vm={rows:[{label:'EMA · σ=0.05 · α=0.55 · K=2 · d=1 · W=0.5 · m=1',statuses:{historical:{code:'FAIL',measurements:{count:81,loss_mean:0.18}},synthetic:{code:'PASS',measurements:{count:30,fp_rate:0.02}}},survived_count:1,available_count:2}]};
 const out=patchLiveMatrixTable(md,vm);
 assert.match(out,/손실 0\.180 \(미통과, 81건\)/);assert.match(out,/FP 0\.020 \(통과, 30건\)/);
 assert.match(out,/### 다음 절/);assert.doesNotMatch(out,/수치 미기록/);
 const row=out.split('\n').find(x=>x.startsWith('| EMA'));
 assert.equal(row.split('|').length,10); // 8 cells + two borders
});
test('partially collected Bojo API does not falsely claim complete',()=>{
 const md='**표 3E. 공식 외부데이터 연결현황**\n\n| Case | Connector | 역할 | 상태 | 관측행 | 기간 |\n|---|---|---|---|---|---|\n| B | bojo_openapi | subsidy_execution | 수집자료 보유 | 10 | 2021 ~ 2021 |\n';
 const out=patchLiveOfficialTable(md,{sources:[{case_layer:'B',connector_id:'bojo_openapi',data_role:'subsidy_execution',readiness:'partial:resume_next_page',coverage:{rows:10,first_period:'2021',last_period:'2021'}}]});
 assert.match(out,/수집 진행 중 \(다음 페이지 대기\)/);assert.doesNotMatch(out,/수집 완료/);
});
