import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { buildDocx } from '../public/docx.js';
import { crc32 } from '../public/zip.js';

const hasPy = (() => { try { execFileSync('python3', ['-c', 'import docx']); return true; } catch { return false; } })();
const hasSqlite = await import('node:sqlite').then(() => true, () => false);

// 테스트용 단색 PNG (외부 의존성 없이 생성)
function png(w, h, rgb = [0, 114, 178]) {
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]));
}

// python-docx로 열어 구조를 JSON으로 돌려받는다 (+ 모든 XML 파트가 well-formed 인지 검사)
function inspect(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-')), f = path.join(dir, 't.docx'); fs.writeFileSync(f, bytes);
  const py = `
import zipfile, json, sys, xml.dom.minidom as md
from docx import Document
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
for n in z.namelist():
    if n.endswith('.xml') or n.endswith('.rels'): md.parseString(z.read(n))
d = Document(sys.argv[1])
print(json.dumps({
 'paras': [(p.style.name, p.text) for p in d.paragraphs],
 'tables': [[[c.text for c in r.cells] for r in t.rows] for t in d.tables],
 'shapes': len(d.inline_shapes), 'media': [n for n in z.namelist() if n.startswith('word/media/')],
 'title': d.core_properties.title, 'parts': z.namelist()}))`;
  return { f, ...JSON.parse(execFileSync('python3', ['-c', py, f], { maxBuffer: 1 << 26 }).toString()) };
}

const MD = '# 테스트 <보고서> & "인용"\n\n> 자동 생성 · 프로젝트 p1\n\n## 1. 개요\n\n본문 **굵게** 와 *기울임* 그리고 `code` 와 σ×α.\n\n**표 1. 예시**\n\n| 변수 | 값 |\n|---|---|\n| σ | 0.1 [0.05, 0.2] (3/10) |\n| α | **굵게** |\n\n- 항목 하나\n- 항목 둘\n\n![그림 1. 캡션](figures/fig_a.png)\n\n*그림 1. 캡션*\n\n![그림 2. 없음](figures/missing.png)\n\n---\n마지막 문단';

test('buildDocx: python-docx가 열 수 있는 유효한 .docx (표·그림·제목·목록·캡션)', { skip: !hasPy && 'python-docx unavailable' }, () => {
  const r = inspect(buildDocx(MD, { images: { fig_a: { data: png(40, 20), w: 720, h: 360 } } }));
  assert.equal(r.title, '테스트 <보고서> & "인용"');
  const st = Object.fromEntries(r.paras.map(([s, t]) => [t, s]));
  assert.equal(st['테스트 <보고서> & "인용"'], 'Title');
  assert.ok(r.paras.some(([s, t]) => /heading 1/i.test(s) && t === '1. 개요'));
  assert.ok(r.paras.some(([s, t]) => s === 'List Bullet' && t === '항목 하나') && r.paras.some(([s, t]) => s === 'Table Caption' && t === '표 1. 예시'));
  assert.ok(r.paras.some(([s, t]) => s === 'Figure Caption' && t === '그림 1. 캡션') && r.paras.some(([, t]) => t.includes('본문 굵게 와 기울임 그리고 code 와 σ×α.')));
  assert.equal(r.tables.length, 1); assert.deepEqual(r.tables[0][0], ['변수', '값']); assert.deepEqual(r.tables[0][2], ['α', '굵게']);
  assert.equal(r.shapes, 1); assert.deepEqual(r.media, ['word/media/image1.png']);
  assert.ok(r.paras.some(([, t]) => t.includes('그림 누락')), '이미지가 없으면 자리표시 문구');
  assert.ok(!r.paras.some(([, t]) => /\*\*|\|---/.test(t)), 'Markdown 기호가 남지 않음');
});

test('buildDocx: 실제 생성 보고서의 표·그림 개수가 Markdown과 일치', { skip: (!hasPy || !hasSqlite) && 'python-docx or node:sqlite unavailable' }, async () => {
  const { makeDb } = await import('./helpers/d1shim.mjs'), { seedProject } = await import('./helpers/seed.mjs'), { generateReport } = await import('../src/lib/report.js'), { buildThesisData } = await import('../src/lib/thesis.js'), { buildFigures } = await import('../public/figures.js');
  const DB = makeDb(), pid = await seedProject(DB), rep = await generateReport({ DB }, pid), figs = buildFigures(await buildThesisData({ DB }, pid));
  const images = Object.fromEntries(figs.map(f => [f.file, { data: png(60, 40), w: f.width, h: f.height }]));
  const r = inspect(buildDocx(rep.content_markdown, { images }));
  const mdTables = (rep.content_markdown.match(/^\|(---\|)+$/gm) || []).length, mdFigs = (rep.content_markdown.match(/^!\[/gm) || []).length;
  assert.ok(mdTables >= 18 && mdFigs === 10 && figs.length === 10);
  assert.equal(r.tables.length, mdTables); assert.equal(r.shapes, mdFigs);
  assert.ok(r.tables.every(t => t.length >= 2 && t[0].every(c => c.length)), '모든 표에 머리행과 본문 행');
  assert.ok(!/undefined|NaN/.test(JSON.stringify(r.paras) + JSON.stringify(r.tables)));
  assert.ok(r.paras.filter(([st]) => st === 'Equation').length >= 30, '번호 붙은 별행 수식이 Word 수식 문단으로 들어감');
  assert.ok(r.paras.some(([st, t]) => st === 'Equation' && t.includes('σ') && t.includes('(6)')), '설계벡터 식 (6)');
  for (const h of ['0. 요약', '1. 박사논문 연구모형 전체 설계', '4. 시뮬레이션 결과', '부록 B. 재현성 정보']) assert.ok(r.paras.some(([s, t]) => /heading/i.test(s) && t.includes(h)), h);
});
