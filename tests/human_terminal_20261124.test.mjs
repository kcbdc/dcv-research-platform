import test from 'node:test';
import assert from 'node:assert/strict';
import {clusterBootstrap} from '../src/lib/reviewer.js';
import {mulberry32,quantile} from '../src/lib/util.js';
import {withNoninferiority} from '../src/lib/validation_matrix.js';
const rows=Array.from({length:960},(_,i)=>({participant_hash:String(i%32),ai_correct:i%3?1:0,human_accept:i%7?1:0,response_ms:1000+i}));
function reference(){const rng=mulberry32(42),groups=Array.from({length:32},(_,i)=>rows.filter(r=>r.participant_hash===String(i))),draws=[];for(let b=0;b<300;b++){const sample=[];for(let i=0;i<32;i++)sample.push(...groups[Math.floor(rng()*32)]);const c=sample.filter(r=>r.ai_correct),w=sample.filter(r=>!r.ai_correct);draws.push(c.filter(r=>r.human_accept).length/c.length-w.filter(r=>r.human_accept).length/w.length);}return [quantile(draws,.025),quantile(draws,.5),quantile(draws,.975)];}
test('grouped bootstrap matches trial resampling exactly',()=>{assert.deepEqual(Object.values(clusterBootstrap(rows,300,42).ci95.discrimination_delta),reference());});
test('missing interval cannot become PASS',()=>{assert.equal(withNoninferiority('PASS',{noninferiority:{comparisons:[{lo:null,hi:null,limit:1}]}},{exact:true}),'HOLD');});
test('bootstrap performance measurement',()=>{const t=performance.now();for(let i=0;i<10;i++)reference();const old=performance.now()-t;const u=performance.now();for(let i=0;i<10;i++)clusterBootstrap(rows,300,42);const next=performance.now()-u;console.log(JSON.stringify({reference_ms:old,optimized_ms:next,speedup:old/next}));});
