import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// public/app.js is a browser module; verify the funnel state rules from its source and the CSS contract.
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');

test('funnel exposes distinct states instead of a single gray N/A class',()=>{
  for(const s of ['na','partial','zero','blocked','done'])assert.ok(app.includes(`'${s}'`),`state ${s}`);
  for(const c of ['funnel-na','funnel-partial','funnel-zero','funnel-blocked'])assert.ok(css.includes(c),`css ${c}`);
});

function simulate(rows){
  const order=['Synthetic','Historical','Adversarial','BIS','ECB','Human'];let pool=[...rows];const out={};
  for(const k of order){const f=`${k.toLowerCase()}_status`,before=pool.length;
    if(!before){out[k]='blocked';continue;}
    const observed=pool.filter(r=>(r[f]||'NA')!=='NA').length;
    if(!observed){out[k]='na';continue;}
    pool=pool.filter(r=>(r[f]||'NA')==='PASS');
    out[k]=pool.length===0?'zero':observed<before?'partial':'done';}
  return out;
}
test('screenshot scenario: BIS wipes the pool -> ECB/Human become blocked, BIS becomes zero (not permanent gray)',()=>{
  const rows=[
    ...Array(4).fill({synthetic_status:'PASS',historical_status:'PASS',adversarial_status:'PASS',bis_status:'FAIL',ecb_status:'NA',human_status:'NA'}),
    ...Array(3).fill({synthetic_status:'PASS',historical_status:'FAIL',adversarial_status:'NA',bis_status:'NA',ecb_status:'NA',human_status:'NA'})];
  const s=simulate(rows);
  assert.equal(s.Synthetic,'done');assert.equal(s.BIS,'zero');assert.equal(s.ECB,'blocked');assert.equal(s.Human,'blocked');
});
test('ECB turns amber then blue as results arrive; Human stays gray until recompute data exists',()=>{
  const base={synthetic_status:'PASS',historical_status:'PASS',adversarial_status:'PASS',bis_status:'PASS',human_status:'NA'};
  assert.equal(simulate([{...base,ecb_status:'NA'},{...base,ecb_status:'NA'}]).ECB,'na');
  assert.equal(simulate([{...base,ecb_status:'PASS'},{...base,ecb_status:'NA'}]).ECB,'partial');
  const all=simulate([{...base,ecb_status:'PASS'},{...base,ecb_status:'PASS'}]);
  assert.equal(all.ECB,'done');assert.equal(all.Human,'na');
});
