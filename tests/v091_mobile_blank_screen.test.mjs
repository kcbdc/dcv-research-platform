import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const index=await readFile(new URL('public/index.html',root),'utf8');
const css=await readFile(new URL('public/style.css',root),'utf8');
const app=await readFile(new URL('public/app.js',root),'utf8');

test('participant portal visibility is controlled by hidden state, not Bootstrap d-none',()=>{
  assert.match(index,/id="humanPortal"[^>]*\shidden/);
  assert.doesNotMatch(index,/id="humanPortal"[^>]*class="[^"]*\bd-none\b/);
  assert.match(app,/portal\.hidden=false/);
  assert.match(app,/portal\.hidden=true/);
  assert.match(css,/\.human-portal\[hidden\]\{display:none!important\}/);
  assert.match(css,/\.human-mode #humanPortal:not\(\[hidden\]\)/);
});

test('mobile navbar uses bounded grid and hides refresh to prevent horizontal overflow',()=>{
  assert.match(css,/grid-template-columns:42px minmax\(0,1fr\) 42px 52px!important/);
  assert.match(css,/#refreshBtn\{display:none!important\}/);
  assert.match(css,/html,body\{max-width:100%;overflow-x:hidden!important\}/);
  assert.match(css,/\.navbar-brand small\{display:none!important\}/);
});

test('current cache buster is applied to all public UI assets',()=>{
  for(const p of ['/style.css?v=0.9.9','/lab.css?v=0.9.9','/app.js?v=0.9.9','/thesis.js?v=0.9.9']) assert.ok(index.includes(p),p);
});
