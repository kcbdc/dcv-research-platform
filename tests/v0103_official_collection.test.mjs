import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const orchestrator=fs.readFileSync(new URL('../src/lib/orchestrator.js',import.meta.url),'utf8');
const index=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');

test('due official collection is not blocked by pending candidate computation',()=>{
  assert.match(orchestrator,/if\(p\.due&&!p\.collecting\)await enqueueOnce\(env,p\.id,'collect_project'/);
  assert.doesNotMatch(orchestrator,/p\.due&&!p\.collecting&&!p\.pending_compute/);
});

test('enabling official connectors immediately queues collection',()=>{
  assert.match(index,/official_enable:true/);
  assert.match(index,/collection:'queued'/);
});
