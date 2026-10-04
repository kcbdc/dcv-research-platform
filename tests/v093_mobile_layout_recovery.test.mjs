import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');

test('mobile/touch dashboard forces compute and projects into one bounded column',()=>{
  assert.match(css,/v0\.9\.3 · mobile dashboard layout recovery/);
  assert.match(css,/@media\(max-width:991\.98px\), \(hover:none\) and \(pointer:coarse\)/);
  assert.match(css,/#computeSection\{[\s\S]*?grid-template-columns:minmax\(0,1fr\)!important/);
  assert.match(css,/#projectsSection\{[\s\S]*?grid-template-columns:minmax\(0,1fr\)!important/);
});

test('mobile chart and nested cards cannot widen the document',()=>{
  assert.match(css,/#regionCanvas\{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important\}/);
  assert.match(css,/#computeSection \.glass-panel,#computeSection article\{[\s\S]*?max-width:100%!important[\s\S]*?overflow:hidden!important/);
  assert.match(css,/html,body,#dashboard,\.dcv-shell\{width:100%;max-width:100%;min-width:0\}/);
});
