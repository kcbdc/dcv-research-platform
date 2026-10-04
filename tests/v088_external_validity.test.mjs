import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluateExternalValidity} from '../src/lib/external_validity.js';

const H='a'.repeat(64),R='b'.repeat(64);

test('external validity defaults to internal computational claims only',()=>{
  const x=evaluateExternalValidity({});
  assert.equal(x.level,'INTERNAL_COMPUTATIONAL');
  assert.equal(x.claim_guard,'INTERNAL_ONLY');
  assert.equal(x.outcome_validated,false);
});

test('Case B aggregate observations only raise contextual scope, not outcome validity',()=>{
  const x=evaluateExternalValidity({case_b_rows:120});
  assert.equal(x.level,'CONTEXTUAL_PUBLIC_PAYMENT');
  assert.equal(x.outcome_validated,false);
  assert.ok(x.does_not_support.some(s=>s.includes('externally validated')));
});

test('verified real public-payment labelled data plus hashed PASS evaluation raises outcome-validity scope',()=>{
  const d={id:'d1',status:'VERIFIED',actual_public_payment:1,outcome_ground_truth:1,independent_source:0,data_hash:H};
  const e={dataset_id:'d1',status:'PASS',n:100,analysis_code_hash:H,result_hash:R,dataset_hash:H,independent_implementation:0,implementation_scope:'dcv_platform'};
  const x=evaluateExternalValidity({datasets:[d],evaluations:[e]});
  assert.equal(x.level,'OUTCOME_VALIDATED_PUBLIC_PAYMENT');
  assert.equal(x.outcome_validated,true);
  assert.equal(x.independent_external_replication,false);
});

test('independent external replication requires independent source and non-DCV implementation',()=>{
  const d={id:'d1',status:'VERIFIED',actual_public_payment:1,outcome_ground_truth:1,independent_source:1,data_hash:H};
  const e={dataset_id:'d1',status:'PASS',n:100,analysis_code_hash:H,result_hash:R,dataset_hash:H,independent_implementation:1,implementation_scope:'independent_python_reimplementation'};
  const x=evaluateExternalValidity({datasets:[d],evaluations:[e]});
  assert.equal(x.level,'INDEPENDENT_EXTERNAL_REPLICATION');
  assert.equal(x.independent_external_replication,true);
});

test('report and approval use external-validity claim gate instead of silently upgrading Case B context',()=>{
  const report=fs.readFileSync(new URL('../src/lib/report.js',import.meta.url),'utf8');
  const approve=fs.readFileSync(new URL('../src/lib/approve.js',import.meta.url),'utf8');
  const api=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
  assert.match(report,/외부 타당도·주장 범위 게이트/);
  assert.match(report,/맥락자료만으로 결과 외적 타당성을 주장할 수 없음/);
  assert.match(approve,/externalValidity\.level==='INTERNAL_COMPUTATIONAL'/);
  assert.match(api,/external-validity.*datasets/);
  assert.match(api,/external-validity.*evaluations/);
});
