import test from 'node:test';import assert from 'node:assert/strict';import {regionVerdicts,executeFinal} from '../src/lib/research_final.js';
const c={sigma:.03,tau:0,alpha:.35,authority_k:2,delay_d:0,recovery_w:.12,adjust_m:.15,estimator:'ema'};
const effects={P1:{direction:1,minimum:.1},P2:{direction:1,minimum:.1}};
test('region propositions distinguish candidate failure and support',()=>{const r=regionVerdicts({region:[{candidate:c,actual:'PASS'},{candidate:{...c,sigma:.1},actual:'FAIL'}],subset:{expansion:0,unknown:0},hypotheses:{P3:'INCONCLUSIVE'}},effects);assert.equal(r.P1,'SUPPORTED');assert.equal(r.P2,'INCONCLUSIVE');assert.equal(r.P4,'SUPPORTED');});
test('unknown region cannot establish subset; counterexample refutes',()=>{const r={region:[{candidate:c,actual:'HOLD'}],subset:{expansion:0,unknown:1},hypotheses:{P3:'INCONCLUSIVE'}};assert.equal(regionVerdicts(r,effects).P4,'INCONCLUSIVE');r.subset.expansion=1;assert.equal(regionVerdicts(r,effects).P4,'REFUTED');});
test('worker cannot execute heavy confirmation',async()=>{await assert.rejects(executeFinal({},'p','h'),/confirm_requires_github_actions/);});
