import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('region empty-state text is measured and wrapped inside the plot box',()=>{
  assert.match(app,/const maxText=Math\.max\(80,cw-24\)/);
  assert.match(app,/ctx\.measureText\(next\)\.width>maxText/);
  assert.match(app,/ctx\.fillText\(t,p\.l\+cw\/2/);
  assert.match(html,/style\.css\?v=0\.10\.0/);
});
