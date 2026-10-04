import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {__test as humanTest,HUMAN_PROTOCOL,humanProtocolHash,submitHumanQuiz,createHumanTrial,recordHumanTrial} from '../src/lib/human_trials.js';
import {balancedFactorialDesign} from '../src/lib/compute.js';

test('migrations 0022-0023 install QC/session/lineage and participant-token schema',()=>{
 const DB=makeDb(), tables=DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
 assert.ok(tables.includes('reviewer_quality_flags'));assert.ok(tables.includes('reviewer_sessions'));assert.ok(tables.includes('research_integrity_checks'));
 const cols=DB.raw.prepare("PRAGMA table_info('design_candidates')").all().map(x=>x.name);assert.ok(cols.includes('design_key'));const sc=DB.raw.prepare("PRAGMA table_info('reviewer_sessions')").all().map(x=>x.name);assert.ok(sc.includes('session_token_hash'));const tc=DB.raw.prepare("PRAGMA table_info('reviewer_trials')").all().map(x=>x.name);assert.ok(tc.includes('protocol_hash'));
});

test('main_v2 schedule fixes 30 trials, 40% AI errors and balances confidence',()=>{
 const rows=humanTest.mainSchedule('participant-001');assert.equal(rows.length,30);assert.equal(rows.filter(x=>!x.ai_correct).length,12);
 for(const c of [.55,.75,.92])assert.equal(rows.filter(x=>x.confidence===c).length,10);
 assert.equal(HUMAN_PROTOCOL,'main_v2');
});

test('balanced_factorial_v2 fully crosses estimator x alpha x W within four nuisance blocks',()=>{
 const d={estimators:['ema','kalman','changepoint','adaptive'],alpha:[.15,.35,.55,.75],W:[.05,.12,.22],sigma:[.03,.05,.1],tau:[0,1,2],K:[0,1,2,3],d:[0,1,2,4],m:[.08,.15,.25]};
 const rows=balancedFactorialDesign(d,192);assert.equal(rows.length,192);
 for(let b=1;b<=4;b++){const xs=rows.filter(x=>x.base_id===`block_${b}`);assert.equal(xs.length,48);assert.equal(new Set(xs.map(x=>`${x.estimator}|${x.alpha}|${x.W}`)).size,48);assert.equal(new Set(xs.map(x=>`${x.sigma}|${x.tau}|${x.K}|${x.d}|${x.m}`)).size,1);}
});
