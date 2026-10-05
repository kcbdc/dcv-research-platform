import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {patchLiveHumanChecklist} from '../src/lib/report.js';

test('live report preflight replaces stale zero participant count with current protocol and publication-ready counts',()=>{
  const old=`## 논문 사용 전 점검 사항\n\n- 현재 인간실험 규약 대상 참가자는 0명이며, 이 중 사전등록 품질기준을 모두 충족해 주분석에 포함 가능한 완료 참가자는 0명으로 사전 기준 32명에 미달합니다(누적 80명). 반복 trial 수는 참가자 수를 대체하지 못합니다.\n- 다른 점검`;
  const md=patchLiveHumanChecklist(old,{protocol_participants:32,publication_participants:32,participants:112,min_participants:32});
  assert.match(md,/현재 인간실험 규약 대상 참가자는 32명/);
  assert.match(md,/주분석에 포함 가능한 참가자는 32명/);
  assert.match(md,/사전 기준 32명은 충족/);
  assert.doesNotMatch(md,/대상 참가자는 0명/);
});

test('report endpoint distinguishes live protocol participants and publication-ready participants and queues refresh at threshold',()=>{
  const src=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
  assert.match(src,/publication_participants/);
  assert.match(src,/protocol_participants/);
  assert.match(src,/stale && Number\(liveHuman\?\.protocol_participants\|\|0\)>=minHuman/);
  assert.match(src,/enqueueOnce\(env,projectId,'generate_report',\{\},105,1\)/);
});
