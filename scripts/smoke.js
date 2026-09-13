/**
 * 문법 검사만으로는 못 잡는 실수를 잡는다.
 *
 * `node --check` 는 파일이 파싱되는지만 본다. 지워진 함수를 부르거나
 * 없는 변수를 참조해도 통과한다. 그래서 실제로 모든 모듈을 불러오고,
 * 본문을 조립하는 주요 경로를 한 번씩 돌려 본다.
 *
 *   npm run smoke
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 불러오기만 해도 포트를 잡고 서버가 뜨는 파일은 뺀다.
const SIDE_EFFECTS = new Set(['server.js']);

function listModules(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listModules(full));
    else if (entry.name.endsWith('.js') && !SIDE_EFFECTS.has(entry.name)) out.push(full);
  }
  return out;
}

const failures = [];

/* 1. 모든 모듈이 실제로 불러와지는지 (없는 import 를 잡는다) */
for (const file of listModules(path.join(ROOT, 'src'))) {
  try {
    await import(`file://${file}`);
  } catch (error) {
    failures.push(`불러오기 실패 ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

/* 2. 본문 조립 경로를 실제로 돌려 본다 (지워진 함수 호출을 잡는다) */
const samplePost = {
  topic: '테스트 주제',
  title: '테스트 제목',
  intro: ['도입 문단입니다.'],
  disclaimer: ['짚고 갈 전제입니다.'],
  criteria: { heading: '고른 기준', paragraphs: ['설명입니다.'], items: ['기준 하나', '기준 둘'] },
  sections: [1, 2, 3, 4].map((n) => ({
    heading: `소제목 ${n}`,
    paragraphs: ['문단입니다.'],
    list: ['목록 항목입니다.'],
    quote: '',
    subsections: [{ heading: '세부 소제목', paragraphs: ['내용입니다.'], list: [] }],
  })),
  table: {
    heading: '비교표',
    headers: ['순위', '이름', '설명'],
    rows: Array.from({ length: 60 }, (_, i) => [String(i + 1), `항목 ${i + 1}`, '특징']),
    note: '참고 자료입니다.',
  },
  checklist: {
    heading: '이것까지 같이 보세요',
    headers: ['확인할 항목', '이유'],
    rows: [['항목', '이유'], ['항목2', '이유2'], ['항목3', '이유3'], ['항목4', '이유4']],
  },
  outro: ['마무리입니다.'],
  footnote: '참고 문구입니다.',
  sources: ['출처 하나'],
  tags: ['태그1', '태그2'],
  thumbnail: { headline: '제목', subline: '부제', badge: '뱃지', accent: '#1F3A93', style: 'bold' },
  compliance: null,
};

const check = async (label, run, verify) => {
  try {
    const value = await run();
    const problem = verify?.(value);
    if (problem) failures.push(`${label}: ${problem}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
};

const html = await import('../src/content/html.js');
const templates = await import('../src/content/templates/index.js');
const highlights = await import('../src/content/highlights.js');
const quality = await import('../src/content/quality.js');
const { DEFAULT_SETTINGS } = await import('../src/lib/settings.js');

await check('buildIntroHtml', () => html.buildIntroHtml(samplePost), (v) => (v ? '' : '빈 문자열'));
await check('buildBodyHtml', () => html.buildBodyHtml(samplePost), (v) => (v.length > 500 ? '' : '본문이 너무 짧음'));
await check('buildPreviewHtml', () => html.buildPreviewHtml(samplePost, ''), (v) => (v ? '' : '빈 문자열'));

await check('buildBodyPlan', () => html.buildBodyPlan(samplePost, [true, true, true]), (plan) => {
  if (!plan.length) return '계획이 비었음';
  if (!plan.some((s) => s.type === 'image')) return '이미지 단계가 없음';
  const tables = plan.filter((s) => s.table);
  if (tables.length !== 2) return `표 전용 단계가 ${tables.length}개 (2개여야 함)`;
  const body = plan.filter((s) => s.type === 'html').map((s) => s.html).join('');
  const dupes = (body.match(/이것까지 같이 보세요/g) || []).length;
  if (dupes !== 1) return `체크리스트 소제목이 ${dupes}번 나옴`;
  return '';
});

await check('buildTableChunks', () => html.buildTableChunks(samplePost.table, 20), (chunks) => {
  if (chunks.length !== 3) return `${chunks.length}조각 (3조각이어야 함)`;
  const rows = chunks.reduce((n, c) => n + (c.match(/<tr/g) || []).length - 1, 0);
  return rows === 60 ? '' : `행 합계 ${rows} (60이어야 함)`;
});

await check('htmlToPlainText', () => html.htmlToPlainText(html.buildBodyHtml(samplePost)), (v) => (
  v.includes('<') ? '태그가 남아 있음' : ''
));

for (const style of ['bold', 'gradient', 'minimal', 'editorial']) {
  await check(`renderTemplate(${style})`, () => templates.renderTemplate({
    ...samplePost.thumbnail, style, width: 1200, height: 630,
  }), (v) => (v.includes('<body>') ? '' : 'HTML 골격이 없음'));
}
await check('renderTemplate(배경 그림)', () => templates.renderTemplate({
  ...samplePost.thumbnail, width: 1200, height: 630, background: 'data:image/png;base64,AAAA',
}), (v) => (v.includes('data:image/png') ? '' : '배경이 안 들어감'));

await check('renderContentCard', () => templates.renderContentCard({
  label: '핵심', headline: '제목', points: ['하나', '둘'], accent: '#1F3A93', width: 1200, height: 640,
}), (v) => (v ? '' : '빈 문자열'));

await check('buildHighlightCards', () => highlights.buildHighlightCards(samplePost), (cards) => (
  cards.length === 3 ? '' : `카드가 ${cards.length}장 (3장이어야 함)`
));

await check('checkCompliance', () => quality.checkCompliance(samplePost, DEFAULT_SETTINGS), (r) => (
  r.results.length >= 15 ? '' : `규칙이 ${r.results.length}개뿐`
));
await check('buildRuleBlock', () => quality.buildRuleBlock(DEFAULT_SETTINGS, 'table'), (v) => (
  v.includes('[분량]') ? '' : '규칙 목록이 비었음'
));

if (failures.length) {
  console.error(`\n검사 실패 ${failures.length}건\n`);
  failures.forEach((line) => console.error(`  - ${line}`));
  process.exit(1);
}
console.log('전부 통과했습니다.');
// 불러온 모듈이 타이머를 붙잡고 있어 그냥 두면 프로세스가 안 끝난다.
process.exit(0);
