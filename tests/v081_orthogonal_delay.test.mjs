import test from 'node:test';
import assert from 'node:assert/strict';
import {__test as engine,balancedFactorialDesign} from '../src/lib/compute.js';
import {mulberry32} from '../src/lib/util.js';

const constraints={loss_max:.18,loss_exceed_max:.1,fp_max:.08,fn_max:.1,review_burden_max:.7,recovery_time_max:4};
const scenario={key:'smoke',rho:.82,drift:0,shift_time:8,shift_magnitude:.3,process_noise:.2,volatility:1,delay_multiplier:1,loss_multiplier:1,empirical_outflow:.12,digital:.8};
const base={sigma:.05,tau:0,alpha:.35,authority_k:2,delay_d:0,recovery_w:.12,adjust_m:.15,estimator:'ema'};
const run=(c,mode,N=200)=>{let fn=0,fp=0,loss=0,dec=0;for(let s=0;s<N;s++){const e=engine.simulateEpisode(c,constraints,mulberry32(100+s),scenario,null,{horizon:90,risk_threshold:.62,confidence_method:'residual_common_v1',delay_mode:mode},mulberry32(900+s));fn+=e.fn;fp+=e.fp;loss+=e.episodeLoss;dec+=e.decisions;}return {fn:fn/dec,fp:fp/dec,loss:loss/N};};

test('v2 block design fully confounds sigma/tau/m (documents the defect); v3 removes it',()=>{
  const v2=engine.designAudit(balancedFactorialDesign({},192)),v3=engine.designAudit(engine.orthogonalBalancedDesign({},192,12345));
  assert.equal(v2.max_cramers_v,1);
  assert.ok(v3.max_cramers_v<0.05,`max Cramer V ${v3.max_cramers_v}`);
});
test('v3 keeps 48 core cells x4, exact marginal balance and is deterministic per seed',()=>{
  const a=engine.orthogonalBalancedDesign({},192,7),b=engine.orthogonalBalancedDesign({},192,7),au=engine.designAudit(a);
  assert.deepEqual(a,b);assert.equal(au.core_cells,48);assert.equal(au.core_reps,4);assert.equal(a.length,192);
  assert.deepEqual(Object.values(au.marginals.sigma),[64,64,64]);assert.deepEqual(Object.values(au.marginals.d),[48,48,48,48]);assert.deepEqual(Object.values(au.marginals.K),[96,96]);
  assert.equal(new Set(a.map(r=>r.base_id)).size,192);
});
test('legacy_v0 reproduces the old defect: FN/FP are exactly invariant to approval delay d',()=>{
  const z=run(base,'legacy_v0',60),d4=run({...base,delay_d:4},'legacy_v0',60);
  assert.equal(z.fn,d4.fn);assert.equal(z.fp,d4.fp);
});
test('queue_v1: approval delay d moves FN, FP and loss monotonically (default reviewer)',()=>{
  const r=[0,1,2,4].map(d=>run({...base,delay_d:d},'queue_v1'));
  for(let i=1;i<r.length;i++){assert.ok(r[i].fn>r[i-1].fn,`FN d idx ${i}`);assert.ok(r[i].loss>r[i-1].loss,`loss d idx ${i}`);}
  assert.ok(r[3].fn>3*r[0].fn);
});
test('queue_v1 with d=0 equals legacy decision path (no hidden lag)',()=>{
  const a=run(base,'queue_v1',60),b=run(base,'legacy_v0',60);assert.equal(a.fn,b.fn);assert.equal(a.fp,b.fp);
});
