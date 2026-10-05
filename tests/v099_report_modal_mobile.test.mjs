import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../public/style.css",import.meta.url),"utf8");
test("report modal uses readable mobile heading and dedicated action toolbar",()=>{
  assert.match(html,/report-modal-heading/);
  assert.match(html,/>연구보고서</);
  assert.match(html,/report-modal-actions/);
  assert.match(css,/#reportModal \.report-modal-header/);
  assert.match(css,/grid-template-areas:"heading close" "actions actions"/);
});
test("rendered report has mobile manuscript typography and full-screen safe area",()=>{
  assert.match(css,/#reportModal \.report-html h1/);
  assert.match(css,/word-break:keep-all!important/);
  assert.match(css,/#reportModal \.report-modal-content\{height:100dvh!important/);
  assert.match(html,/style\.css\?v=0\.10\.2/);
});
