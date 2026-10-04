import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {issueHumanInvite} from '../src/lib/human_trials.js';
import {calibrateConstraintQuantiles,quantile} from '../src/lib/constraint_calibration.js';
import {routeAccessClass,secureEqual} from '../src/lib/auth.js';

test('constraint quantile calibration uses only confirmatory/robust phases and rounds upper targets upward',()=>{
 const rows=[];for(let i=1;i<=100;i++)rows.push({phase:i<=50?'confirmation':'historical',loss_mean:i/1000,loss_exceed_rate:i/2000,fp_rate:i/5000,fn_rate:i/2500,review_burden:i/1000,recovery_time:i/50});
 rows.push({phase:'exploration',loss_mean:99,loss_exceed_rate:99,fp_rate:99,fn_rate:99,review_burden:99,recovery_time:99});
 const c=calibrateConstraintQuantiles(rows,{quantileLevel:.9,minRuns:20});
 assert.equal(c.adequate,true);assert.equal(c.run_count,100);assert.ok(c.proposal.loss_max>=quantile(rows.slice(0,100).map(r=>r.loss_mean),.9));assert.ok(c.proposal.fn_max<1);assert.match(c.warning,/new research cycle/i);
});

test('route access classifier keeps participant study separate from admin surface',()=>{
 assert.equal(routeAccessClass(['api','health'],'GET'),'public');
 assert.equal(routeAccessClass(['api','projects','p','reviewer-quiz'],'POST'),'public-human-bootstrap');
 assert.equal(routeAccessClass(['api','projects','p','reviewer-trials'],'POST'),'human-session');
 assert.equal(routeAccessClass(['api','projects'],'GET'),'admin');
 assert.equal(secureEqual('abc','abc'),true);assert.equal(secureEqual('abc','abd'),false);
});

test('human session must be in dedicated header and admin bearer cannot substitute',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:0,reviewer:0,episodes:0}),env={DB,ADMIN_TOKEN:'admin-secret'};
 const inv=await issueHumanInvite(env,id,{});
 const q=await worker.fetch(new Request(`https://x/api/projects/${id}/reviewer-quiz`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({participant_hash:'participant-v083-01',answers:[true,false,true,false,true],invite_token:inv.invite_token})}),env,{});assert.equal(q.status,201);const qb=await q.json();
 const bodyToken=await worker.fetch(new Request(`https://x/api/projects/${id}/reviewer-trials`,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer admin-secret'},body:JSON.stringify({participant_hash:'participant-v083-01',session_token:qb.session_token})}),env,{});assert.equal(bodyToken.status,401);
 const ok=await worker.fetch(new Request(`https://x/api/projects/${id}/reviewer-trials`,{method:'POST',headers:{'content-type':'application/json','x-human-session':qb.session_token},body:JSON.stringify({participant_hash:'participant-v083-01'})}),env,{});assert.equal(ok.status,201);
});

test('admin constraint calibration requires a prior cycle and remains fail-closed',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:5,reviewer:0,episodes:0});
 const denied=await worker.fetch(new Request(`https://x/api/projects/${id}/constraint-calibration`),{DB},{});assert.equal(denied.status,503);
 const denied2=await worker.fetch(new Request(`https://x/api/projects/${id}/constraint-calibration`,{headers:{authorization:'Bearer wrong'}}),{DB,ADMIN_TOKEN:'secret'},{});assert.equal(denied2.status,401);
 const noPrior=await worker.fetch(new Request(`https://x/api/projects/${id}/constraint-calibration`,{headers:{authorization:'Bearer secret'}}),{DB,ADMIN_TOKEN:'secret'},{});assert.equal(noPrior.status,409);const j=await noPrior.json();assert.equal(j.error,'no_prior_cycle_for_constraint_calibration');
});

import {__test as engine} from '../src/lib/compute.js';
import {mulberry32} from '../src/lib/util.js';
test('loss_max is an active engine constraint (not a report-only field)',()=>{const c={sigma:.05,tau:0,alpha:.35,authority_k:2,delay_d:0,recovery_w:.12,adjust_m:.15,estimator:'ema'},sc={key:'x',rho:.82,drift:0,shift_time:8,shift_magnitude:.3,process_noise:.2,volatility:1,delay_multiplier:1,loss_multiplier:1,empirical_outflow:.12,digital:.8};let a=engine.emptyAgg();for(let i=0;i<120;i++)engine.mergeAgg(a,engine.simulateEpisode(c,{loss_max:.00001,loss_exceed_max:1,fp_max:1,fn_max:1,review_burden_max:1,recovery_time_max:100},mulberry32(i+1),sc,null,{horizon:90,risk_threshold:.62,confidence_method:'residual_common_v1',delay_mode:'queue_v1'},mulberry32(i+1000)));const z=engine.finalizeAgg(a,{loss_max:.00001,loss_exceed_max:1,fp_max:1,fn_max:1,review_burden_max:1,recovery_time_max:100},.95,{});assert.ok(z.constraints.some(e=>e.metric==='loss_mean'&&e.limit===.00001));});
