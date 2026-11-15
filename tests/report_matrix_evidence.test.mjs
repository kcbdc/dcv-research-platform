import test from 'node:test';
import assert from 'node:assert/strict';
import {matrixEvidenceCell} from '../src/lib/report.js';

test('matrix prints measured values even for genuinely failed gates',()=>{
 const text=matrixEvidenceCell({code:'FAIL',measurements:{count:81,loss_mean:0.1823,fp_rate:0.0314}});
 assert.match(text,/손실 0\.182/);assert.match(text,/FP 0\.031/);assert.match(text,/미통과/);
});
test('matrix never fabricates evidence or promotes missing to passing',()=>{
 assert.equal(matrixEvidenceCell({code:'MISSING',measurements:{count:0}}),'시나리오 미실행');
 assert.equal(matrixEvidenceCell({code:'MISSING',source:'human_recompute_validation'}),'인간 재계산 대기');
 assert.equal(matrixEvidenceCell({code:'FAIL'}),'판정 미통과 · 지표 미저장');
});
test('matrix reports observed data with boundary verdict',()=>{
 assert.match(matrixEvidenceCell({code:'HOLD',measurements:{count:3,fn_rate:0.12}}),/FN 0\.120 \(경계, 3건\)/);
});
