import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

test('v0.10.0 detail data cards collapse to one contained column below 1400px',()=>{
  assert.match(css,/@media\(max-width:1399\.98px\)[\s\S]*#detailPanel>\.row\.g-3\.mt-1\{display:grid!important;grid-template-columns:minmax\(0,1fr\)!important/);
  assert.match(css,/#empiricalSection,#dataSection,#dataSection>\*\{min-width:0!important;max-width:100%!important\}/);
});

test('v0.10.0 long status and funnel text cannot widen viewport',()=>{
  assert.match(css,/#empiricalStatus,#fdicStatus,#officialStatus/);
  assert.match(css,/overflow-wrap:anywhere!important/);
  assert.match(css,/#dataSection \.funnel-step[\s\S]*max-width:100%!important/);
});

test('v0.10.0 cache-busts responsive assets',()=>{
  assert.match(html,/style\.css\?v=0\.10\.2/);
  assert.match(html,/lab\.css\?v=0\.10\.2/);
});
