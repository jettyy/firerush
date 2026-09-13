import { runClaudeJson } from '../ai/claude.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { buildExampleBlock } from './examples.js';
import { detectShape, generateTableRows, ITEM_LIMIT } from './ranking.js';
import { buildBannedBlock, buildPersonaBlock, buildVoiceBlock } from './persona.js';
import {
  buildRuleBlock, buildRepairBlock, checkCompliance, countChars, summarize,
} from './quality.js';

const BASE_SYSTEM = [
  '당신은 네이버 블로그 상위 노출 로직을 꿰고 있는 블로그 작성자입니다.',
  '검색 엔진이 "사람이 직접 겪고 쓴 글"로 인식하도록, 정해진 화자의 1인칭 경험담으로 씁니다.',
  '백과사전식 설명 대신 내 상황과 구체적인 숫자를 섞고, 확실하지 않은 통계나 수치는 지어내지 않습니다.',
  '특수문자와 이모지를 쓰지 않고 깔끔한 텍스트로만 씁니다.',
  'HTML 태그나 마크다운 기호를 글자로 적지 않고, 요청받은 JSON 형식만 정확히 출력합니다.',
].join(' ');

/**
 * 사용자 지침을 프롬프트 맨 앞에 놓는 블록.
 * 고정 규칙 목록 끝에 한 줄로 붙으면 묻히기 때문에 별도 최상위 섹션으로 올린다.
 *
 * 다만 품질 필수 규칙보다는 아래에 둔다. 이 프로그램의 목적 자체가
 * "좋은 글" 이라서, 규칙을 깨는 지침까지 이기게 하면 프로그램이 무의미해진다.
 */
export function buildGuidelineBlock(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return '';
  return `[사용자 지침 — 반드시 반영할 것]
아래는 사용자가 이 글에 직접 요구한 내용입니다.
일반적인 작성 요령과 충돌하면 이 지침을 우선하세요.
(단, 뒤에 나오는 "필수 준수 규칙"만은 어길 수 없습니다. 둘 다 만족시키세요.)

${text.split('\n').map((line) => (line.trim() ? `- ${line.trim()}` : '')).filter(Boolean).join('\n')}

============================================================

`;
}

/** 프롬프트 맨 끝에서 한 번 더 짚어준다. 마지막에 읽은 지시를 더 잘 따른다. */
function buildGuidelineReminder(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return '';
  return `

============================================================
[마지막 확인 — 사용자 지침을 지켰습니까?]
${text}

출력하기 전에 위 지침을 하나씩 다시 확인하세요.
지키지 못한 항목이 있으면 고쳐서 출력하고, guidelineCheck 필드에
각 지침을 어떻게 반영했는지 한 줄로 적으세요.`;
}

function buildSystemPrompt(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return BASE_SYSTEM;
  return (
    `${BASE_SYSTEM} 사용자가 직접 준 지침이 있으면 그것을 반영하되, `
    + `필수 준수 규칙은 어떤 경우에도 지킵니다. `
    + `이번 사용자 지침: ${text.replace(/\s+/g, ' ').slice(0, 500)}`
  );
}

/* ------------------------------------------------------------------ */
/* 프롬프트 조각                                                        */
/* ------------------------------------------------------------------ */

function basicsBlock(settings, topic) {
  const { audience, sectionCount, minChars } = settings.post;
  return [
    '[포스팅 기본 정보]',
    `- 주제: ${topic}`,
    `- 읽는 사람: ${audience}`,
    `- 목표 분량: 공백 제외 ${minChars.toLocaleString()}자 이상 (넘겨도 좋습니다)`,
    `- 소제목: ${sectionCount}개 내외`,
  ].join('\n');
}

const THUMBNAIL_BLOCK = `[썸네일 문구]
- headline: 18자 이내 / subline: 30자 이내 / badge: 6자 이내
- style: bold, gradient, minimal, editorial 중 하나
- accent: 어두운 계열 HEX (흰 글씨가 올라갑니다)
- 썸네일 문구에도 특수문자와 이모지를 쓰지 마세요.
- scene: 썸네일 배경에 그릴 그림을 영어 한 줄로 묘사하세요. 글자는 그리지 않습니다.
  주제를 한눈에 알아볼 수 있는 사물이나 장면으로 쓰세요.
  (예: "a city skyline with university buildings and students holding books")`;

function metaBlock() {
  return `[태그]
- tags: 8~10개. 네이버 검색 유입을 노리는 해시태그입니다.
- 주제의 핵심 키워드, 함께 검색될 만한 말, 내 상황을 나타내는 말을 섞어 쓰세요.
- 한 단어~두 단어로 짧게, # 기호 없이 글자만 적습니다.`;
}

/** 표를 한 번에 받아도 되는 글용 JSON 형식 안내. */
function jsonShape({ withItems, withCriteria, withTableRows }) {
  const criteria = withCriteria
    ? `\n  "criteria": {
    "heading": "추천 항목을 고른 세 가지 기준",
    "paragraphs": ["기준을 왜 이렇게 잡았는지 설명하는 완전한 문장 2~3개입니다."],
    "items": ["첫 번째 기준: 왜 이 기준을 봤는지 설명입니다.", "두 번째 기준: 왜 이 기준을 봤는지 설명입니다."]
  },`
    : '';

  const table = withTableRows
    ? `\n  "table": {"heading":"한눈에 보는 비교표","headers":["구분","항목","핵심 특징","난이도"],"rows":[["1","항목 이름","특징","보통"]],"note":"표 아래 안내 한 줄입니다."},`
    : `\n  "table": {"heading":"한눈에 보는 비교표","headers":["구분","항목","핵심 특징","난이도"],"note":"표 아래 안내 한 줄입니다."},`;

  const section = withItems
    ? `{
      "heading": "1위. 항목 이름",
      "isItem": true,
      "paragraphs": ["이 항목을 왜 먼저 다루는지 설명하는 문단입니다."],
      "subsections": [
        {"heading":"상세 설명","paragraphs":["..."]},
        {"heading":"특징","paragraphs":["..."]},
        {"heading":"장점과 단점","paragraphs":["..."], "list":["장점을 문장으로 씁니다.","단점도 솔직하게 적습니다."]},
        {"heading":"이럴 때 추천합니다","paragraphs":["..."]}
      ]
    }`
    : `{
      "heading": "소제목",
      "paragraphs": ["문단1","문단2"],
      "list": ["핵심 포인트를 완전한 문장으로 정리합니다."],
      "quote": "",
      "subsections": [{"heading":"세부 소제목","paragraphs":["..."]}]
    }`;

  return `{
  "title": "제목 (낚시성 없이 명확하게, 40자 이내)",
  "summary": "한 줄 요약입니다.",
  "tags": ["태그1","태그2","태그3","태그4","태그5","태그6","태그7","태그8"],
  "guidelineCheck": "사용자 지침을 어떻게 반영했는지 한 줄 (지침 없으면 \\"\\")",
  "thumbnail": {"headline":"...","subline":"...","badge":"...","style":"minimal","accent":"#1F3A93","scene":"English one-line description of the background artwork, no text in it"},
  "intro": ["도입 문단1", "도입 문단2", "도입 문단3"],
  "disclaimer": ["본론 전에 짚고 갈 오해나 전제를 적는 문단입니다.", "왜 그런지 설명하는 문단입니다."],${criteria}${table}
  "sections": [
    ${section}
  ],
  "checklist": {"heading":"이것까지 같이 보세요","headers":["확인할 항목","제가 중요하다고 본 이유"],"rows":[["항목 이름","왜 중요한지 한 줄"]]},
  "outro": ["지금 어떻게 쓰고 있는지 덤덤하게 적는 문단입니다.", "내일 써 볼 다음 글을 예고하며 끝내는 문단입니다."],
  "footnote": "이 글의 자료 성격과 직접 확인이 필요한 부분을 밝히는 한 문단입니다.",
  "sources": ["참고한 자료 이름과 출처 (검색해서 본 것만)"]
}`;
}

function structureGuide(shape, settings, count) {
  const lines = [
    '[글의 흐름]',
    '서론-본론-결론처럼 각을 잡지 말고, 아래 순서대로 이야기가 자연스럽게 흘러가게 쓰세요.',
    '',
    '- intro: 근황이나 이 주제를 찾아보게 된 사소한 계기로 시작하는 2~3문단. '
      + '인사말도, "오늘 알아볼 주제는" 같은 안내도 넣지 마세요.',
  ];
  if (settings.post.addCriteria && shape !== 'general') {
    lines.push('- criteria: 내가 뭘 보고 골랐는지 밝히는 단락. 기준을 왜 그렇게 잡았는지도 내 상황에 빗대어 씁니다.');
  }
  lines.push('- table: 한눈에 보이게 정리한 표. 열 3~5개.');

  if (shape === 'items') {
    lines.push(
      `- sections: 항목 ${count ? `${count}개` : `${Math.min(5, settings.post.sectionCount + 1)}개 내외`}를 `
      + '각각 하나의 섹션으로 다룹니다. isItem 을 true 로 두세요.',
    );
    lines.push('- 각 항목 섹션에는 세부 소제목을 최소 3개 넣습니다: 어떤 물건·내용인지 / 실제로 써 보니 / 아쉬운 점 / 이런 사람에게');
    lines.push('- 소제목은 "1. 개요" 가 아니라 "생각보다 조립이 오래 걸렸습니다" 처럼 그 대목의 이야기를 그대로 적으세요.');
    lines.push('- 항목마다 아쉬운 점과 주의할 점도 솔직하게 적으세요. 장점만 나열하면 광고 글로 보입니다.');
  } else if (shape === 'table') {
    lines.push('- sections: 표를 어떻게 봐야 하는지, 고를 때 내가 중요하게 본 것, '
      + '그중 직접 눈여겨본 항목 3~4개 이야기로 나눕니다.');
    lines.push('- 대표 항목 섹션에는 세부 소제목을 붙여 내용을 나누세요.');
  } else {
    lines.push(`- sections: 소제목 ${settings.post.sectionCount}개. `
      + '각 섹션에 세부 소제목을 1개 이상 붙여 내용을 나눕니다.');
    lines.push('- 최소 한 섹션에는 불렛 포인트 목록(list)을 넣으세요.');
  }

  lines.push(
    '- checklist: 마무리 직전에 "이것까지 같이 보세요" 2열 표를 하나 더 넣습니다. '
    + '왼쪽은 확인할 항목, 오른쪽은 내가 그걸 왜 중요하게 봤는지. 5~6줄.',
    '- 어느 한 군데에는 남들이 쓴 글에는 없을, 직접 해 보지 않으면 모를 디테일을 한두 문장 넣으세요. '
    + '("케이블이 미묘하게 짧아서 콘센트 위치를 먼저 보는 게 낫더라고요" 같은 것)',
    '- outro: 억지 요약 없이 덤덤하게 끝내는 2문단. '
    + '마지막 문단에는 이어서 쓸 다음 글을 예고하세요. '
    + '("내일은 범위를 좁혀서 서울권과 경기권을 따로 나눠보려고 합니다" 같은 한 문장)',
  );
  return lines.join('\n');
}

/**
 * 검색을 쓸 수 있을 때와 없을 때는 "정직하게 쓰는 법" 자체가 달라진다.
 *
 * 검색이 막혀 있으면 수치를 아예 못 쓰게 막는 것이 최선이지만,
 * 그러면 글에 근거가 사라져서 누구나 쓸 수 있는 뻔한 글이 된다.
 * 검색이 열려 있으면 반대로 "확인한 것만, 출처와 함께" 쓰라고 요구한다.
 */
function honestyBlock(canSearch) {
  if (!canSearch) {
    return [
      '[사실관계]',
      '- 실시간 검색을 할 수 없으므로, 공식 조사 수치나 연도별 통계를 지어내지 마세요.',
      '- 가격이나 사양을 적을 때는 "대략 4만 원대" 처럼 범위로 쓰고, 소수점까지 정확한 척하지 마세요.',
      '- 순위는 절대적인 우열이 아니라 "널리 알려진 정보를 정리한 참고 순서" 로 다루세요.',
      '- 모르는 제도나 금액은 "지역과 시기에 따라 다릅니다" 처럼 정직하게 여지를 두고 쓰세요.',
    ].join('\n');
  }
  return [
    '[사실관계 — 검색해서 확인하고 쓰세요]',
    '- WebSearch 도구를 쓸 수 있습니다. 글을 쓰기 전에 이 주제의 최신 자료를 먼저 검색하세요.',
    '- 순위, 통계, 가격, 제도처럼 사람들이 확인하러 들어오는 숫자는 반드시 검색으로 확인하고 쓰세요. '
    + '기억에 의존해 쓰지 마세요.',
    '- 수치를 쓸 때는 어디서 나온 숫자인지 문장 안에 밝히세요. '
    + '("2026 QS 자료를 보면 서울대학교가 세계 38위로 나타나고 있어요" 처럼)',
    '- 검색해도 확인이 안 되는 숫자는 그냥 쓰지 마세요. 빼거나 "지역과 시기에 따라 다릅니다" 로 넘기세요.',
    '- sources 에 실제로 참고한 자료를 3~6개 적으세요. 검색해서 본 것만 적고, 지어내지 마세요.',
    '- 검색 결과가 서로 다르면 그 사실 자체를 글에 적으세요. 어느 한쪽만 골라 단정하지 마세요.',
  ].join('\n');
}

/** 이 글이 어디까지 말할 수 있는지 스스로 밝히게 하는 블록. */
const CAUTION_BLOCK = [
  '[신뢰도 — 이 세 가지가 글의 급을 가릅니다]',
  '- disclaimer: 본론에 들어가기 전에 "이 주제에서 사람들이 오해하는 것"을 먼저 짚으세요. '
  + '특히 공식적으로 존재하지 않는 것을 있는 것처럼 다루면 안 됩니다. '
  + '("교육부나 대교협에서 공식적으로 발표하는 대학 서열은 없습니다" 같은 문장)',
  '- 본문 중간에 이 글의 한계를 한 번 더 짚으세요. '
  + '("24위와 25위가 정확히 한 단계 차이라고 받아들이는 건 추천하지 않습니다" 같은 문장)',
  '- footnote: 글 맨 끝에 이 자료의 성격과 확인이 필요한 부분을 한 문단으로 적으세요.',
  '- table.note 에는 이 표가 공식 자료가 아니라는 점과 직접 확인이 필요하다는 안내를 넣으세요.',
].join('\n');

/**
 * 이 프로그램은 AI가 준 JSON을 그대로 네이버 에디터 서식으로 옮겨 적는다.
 * 그래서 AI가 HTML 코드를 써 보내면 화면에 태그가 글자로 찍힌다.
 * "코드가 아니라, 코드가 그려낸 최종 결과물의 글자만" 달라는 뜻을 못 박아 둔다.
 */
const FORMAT_BLOCK = [
  '[아주 중요 — 출력은 HTML 코드가 아닙니다]',
  '- 이 글은 프로그램이 네이버 블로그 에디터에 그대로 옮겨 적습니다. '
  + '소제목 크기, 문단 간격, 표 테두리, 강조 색은 프로그램이 알아서 입힙니다.',
  '- 그러니 <p>, <br>, <h3>, <div>, <table>, <span style="..."> 같은 태그를 쓰지 마세요. '
  + '쓰면 독자 화면에 태그가 글자로 그대로 찍힙니다.',
  '- HTML로 만들었을 때 화면에 "보이는 글자"만 그대로 적으면 됩니다. '
  + '줄바꿈도 태그로 넣지 말고, 문단을 나눠서 배열 항목을 하나 더 만드세요.',
  '- 딱 하나 예외로, 문단 안에서 핵심 표현 한둘만 <b>강조</b>로 감쌀 수 있습니다.',
  '- 마크다운 기호(#, *, -, |)도 문자열 안에 넣지 마세요. 구조는 JSON 필드로만 표현합니다.',
  '- 목록 항목과 표 칸도 특수문자 없이 글자만 씁니다.',
].join('\n');

/* ------------------------------------------------------------------ */
/* 프롬프트 조립                                                        */
/* ------------------------------------------------------------------ */

function buildMainPrompt(topic, settings, { guidelineBlock, exampleBlock, shape, count, canSearch }) {
  const withTableRows = shape !== 'table';   // 큰 표는 뒤에서 따로 채운다.
  const tableHint = withTableRows
    ? `- table.rows 를 ${count ? `${count}개` : '항목 수만큼'} 빠짐없이 채우세요. "이하 생략" 금지.`
    : `- 이 글에는 ${count}개 항목이 들어간 큰 표가 하나 들어갑니다. `
      + '표의 행은 뒤에서 따로 채우므로 지금은 headers 와 heading, note 만 잡고 rows 는 넣지 마세요.\n'
      + '- table.headers 의 첫 열은 반드시 "순위" 로 두세요. 그 뒤에 3~4개 열을 더 정하면 됩니다.';

  const personaBlock = buildPersonaBlock(settings);
  const bannedBlock = buildBannedBlock(settings);

  return `${guidelineBlock}${personaBlock ? `${personaBlock}\n\n` : ''}${basicsBlock(settings, topic)}

위 주제로 네이버 블로그에 올릴 글 한 편을 써주세요.
검색해서 들어온 사람이 끝까지 읽고, 검색 엔진이 "사람이 직접 겪고 쓴 글"로 인식해야 합니다.

${buildVoiceBlock(settings)}
${bannedBlock ? `\n${bannedBlock}\n` : ''}
${buildRuleBlock(settings, shape)}

${structureGuide(shape, settings, count)}
${tableHint}

${honestyBlock(canSearch)}

${CAUTION_BLOCK}

${FORMAT_BLOCK}

${metaBlock()}

${THUMBNAIL_BLOCK}
${exampleBlock ? `\n${exampleBlock}\n` : ''}
[출력] JSON 객체 하나만. 설명도 코드 펜스도 붙이지 마세요.

${jsonShape({
    withItems: shape === 'items',
    withCriteria: settings.post.addCriteria && shape !== 'general',
    withTableRows,
  })}

필요 없는 키는 빼도 되지만 title, intro, sections, outro, table 은 반드시 채우세요.${buildGuidelineReminder(settings.post.extraGuideline)}`;
}

/* ------------------------------------------------------------------ */
/* 응답 정규화                                                          */
/* ------------------------------------------------------------------ */

const STYLES = new Set(['bold', 'gradient', 'minimal', 'editorial']);

/**
 * 프롬프트로 "HTML 코드를 쓰지 말라"고 못 박아 두었지만, 모델이 가끔 태그를 섞어 보낸다.
 * 그대로 두면 에디터 화면에 태그가 글자로 찍히므로 여기서 걷어낸다.
 * 서식으로 허용한 <b> 만 남기고(속성은 떼고), 나머지 태그는 지운다.
 */
function stripTags(text) {
  return String(text)
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) => {
      if (tag.toLowerCase() !== 'b') return '';
      return match.startsWith('</') ? '</b>' : '<b>';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 제목·썸네일 문구처럼 태그가 하나도 들어가면 안 되는 자리. */
function plain(text) {
  return stripTags(text).replace(/<\/?b>/gi, '').trim();
}

function toParagraphList(value) {
  if (Array.isArray(value)) return value.map((v) => stripTags(v)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    const cleaned = stripTags(value);
    return cleaned ? [cleaned] : [];
  }
  return [];
}

function normalizeTable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const headers = (Array.isArray(raw.headers) ? raw.headers : [])
    .map((header) => stripTags(header ?? ''))
    .filter(Boolean);
  if (headers.length < 2) return null;

  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .map((row) => {
      const cells = Array.isArray(row)
        ? row.map((cell) => stripTags(cell ?? ''))
        : (row && typeof row === 'object' ? Object.values(row).map((cell) => stripTags(cell ?? '')) : null);
      if (!cells) return null;
      const fixed = cells.slice(0, headers.length);
      while (fixed.length < headers.length) fixed.push('');
      return fixed;
    })
    .filter((row) => row && row.some((cell) => cell));

  return {
    heading: stripTags(raw.heading || ''),
    headers,
    rows,
    note: stripTags(raw.note || ''),
  };
}

function normalizeSubsections(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((sub) => ({
      heading: stripTags(sub?.heading || ''),
      paragraphs: toParagraphList(sub?.paragraphs ?? sub?.body ?? sub?.content),
      list: toParagraphList(sub?.list ?? sub?.items),
    }))
    .filter((sub) => sub.heading && (sub.paragraphs.length || sub.list.length));
}

function normalizeCriteria(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const criteria = {
    heading: stripTags(raw.heading || '추천 항목을 고른 기준'),
    paragraphs: toParagraphList(raw.paragraphs ?? raw.body),
    items: toParagraphList(raw.items ?? raw.list),
  };
  if (!criteria.paragraphs.length && !criteria.items.length) return null;
  return criteria;
}

export function normalize(raw, topic, settings, shape = 'general') {
  const title = plain(raw.title || topic).slice(0, 100);

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((section) => ({
      heading: stripTags(section?.heading || ''),
      isItem: Boolean(section?.isItem),
      paragraphs: toParagraphList(section?.paragraphs ?? section?.body ?? section?.content),
      list: toParagraphList(section?.list ?? section?.items),
      quote: stripTags(section?.quote || ''),
      subsections: normalizeSubsections(section?.subsections ?? section?.sub),
    }))
    .filter((section) => section.heading || section.paragraphs.length);

  const thumb = raw.thumbnail && typeof raw.thumbnail === 'object' ? raw.thumbnail : {};
  const requested = settings.thumbnail.style;
  const style = requested !== 'auto' && STYLES.has(requested)
    ? requested
    : (STYLES.has(thumb.style) ? thumb.style : 'bold');
  const accent = /^#[0-9a-f]{6}$/i.test(String(thumb.accent || '')) ? thumb.accent : '#16324F';

  const post = {
    topic,
    shape,
    title,
    summary: plain(raw.summary || ''),
    guideline: String(settings.post.extraGuideline || '').trim(),
    guidelineCheck: String(raw.guidelineCheck || '').trim(),
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((tag) => String(tag).replace(/^#/, '').replace(/,/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 10),
    thumbnail: {
      headline: plain(thumb.headline || title).slice(0, 40),
      subline: plain(thumb.subline || raw.summary || '').slice(0, 60),
      badge: plain(thumb.badge || '').slice(0, 12),
      scene: plain(thumb.scene || '').slice(0, 300),
      emoji: String(thumb.emoji || '').trim().slice(0, 4),
      style,
      accent,
    },
    intro: toParagraphList(raw.intro),
    disclaimer: toParagraphList(raw.disclaimer),
    criteria: settings.post.addCriteria && shape !== 'general'
      ? normalizeCriteria(raw.criteria)
      : null,
    table: normalizeTable(raw.table),
    sections,
    checklist: normalizeTable(raw.checklist),
    outro: toParagraphList(raw.outro),
    footnote: stripTags(raw.footnote || ''),
    sources: toParagraphList(raw.sources).slice(0, 8),
    model: '',
    costUsd: 0,
    compliance: null,
    repairs: 0,
  };

  if (!post.intro.length && post.sections.length) {
    // 도입부가 비면 썸네일이 들어갈 자리가 없어진다. 첫 문단을 끌어올린다.
    post.intro = post.sections[0].paragraphs.splice(0, 1);
  }
  if (!post.sections.length) {
    throw new Error('AI 응답에 본문 섹션이 없습니다.');
  }
  return post;
}

/** 보정 요청에 되돌려 보낼 JSON. 내부 관리용 필드는 뺀다. */
function toAiJson(post) {
  const out = {
    title: post.title,
    summary: post.summary,
    tags: post.tags,
    guidelineCheck: post.guidelineCheck,
    thumbnail: post.thumbnail,
    intro: post.intro,
    sections: post.sections.map((section) => ({
      heading: section.heading,
      ...(section.isItem ? { isItem: true } : {}),
      paragraphs: section.paragraphs,
      ...(section.list.length ? { list: section.list } : {}),
      ...(section.quote ? { quote: section.quote } : {}),
      ...(section.subsections.length ? { subsections: section.subsections } : {}),
    })),
    outro: post.outro,
  };
  if (post.disclaimer?.length) out.disclaimer = post.disclaimer;
  if (post.criteria) out.criteria = post.criteria;
  if (post.table) out.table = post.table;
  if (post.checklist) out.checklist = post.checklist;
  if (post.footnote) out.footnote = post.footnote;
  if (post.sources?.length) out.sources = post.sources;
  return out;
}

export { countChars };

/** 첫 열이 순위 번호임을 알려주는 머리글. */
const RANK_HEADER = /^(순위|번호|랭킹|순번|구분|no\.?|#|rank)$/i;
const MAX_COLUMNS = 5;

/**
 * 큰 표는 행을 따로 받아 채우는데, 그때 첫 칸에는 항상 순위 번호가 들어간다.
 * 그런데 AI가 첫 열 머리글을 "브랜드" 처럼 잡아버리면 번호가 엉뚱한 열에 박힌다.
 * 그래서 첫 열이 순위 열이 아니면 순위 열을 앞에 끼워 넣는다.
 */
function buildTableHeaders(raw) {
  const headers = (Array.isArray(raw) ? raw : [])
    .map((header) => String(header ?? '').trim())
    .filter(Boolean);
  if (headers.length < 2) return ['순위', '항목', '핵심 특징'];
  if (RANK_HEADER.test(headers[0])) return headers.slice(0, MAX_COLUMNS);
  // 열이 너무 많아지면 모바일에서 표가 깨진다. 뒤쪽 열을 덜어낸다.
  return ['순위', ...headers].slice(0, MAX_COLUMNS);
}

/* ------------------------------------------------------------------ */
/* 생성                                                                */
/* ------------------------------------------------------------------ */

/**
 * 준수 검사에서 걸린 항목만 짚어 다시 쓰게 한다.
 * 규칙이 통과할 때까지 최대 maxRepairs 번 돈다.
 */
async function repairUntilCompliant(post, { topic, settings, systemPrompt, signal, onProgress }) {
  let current = post;
  current.compliance = checkCompliance(current, settings);

  if (current.compliance.ok || !settings.quality.enforce) return current;

  const limit = Math.max(0, Number(settings.quality.maxRepairs) || 0);
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    logger.warn(
      `[${topic}] 품질 검사 미통과 (${attempt}/${limit} 보정 시도) — `
      + current.compliance.issues.map((issue) => `${issue.label}: ${issue.detail}`).join(' / '),
    );
    onProgress?.(current.compliance);

    const prompt = [
      buildRepairBlock(current.compliance),
      '',
      '============================================================',
      `주제: "${topic}"`,
      '',
      '[현재 글 — 이것을 고쳐서 전체를 다시 출력하세요]',
      JSON.stringify(toAiJson(current), null, 2),
      '',
      buildPersonaBlock(settings),
      '',
      buildVoiceBlock(settings),
      '',
      buildBannedBlock(settings),
      '',
      buildRuleBlock(settings, current.shape),
      '',
      FORMAT_BLOCK,
      '',
      '[출력] 고친 글 전체를 같은 구조의 JSON 객체 하나로만 출력하세요.',
    ].join('\n');

    let reply;
    try {
      reply = await runClaudeJson(prompt, { systemPrompt, signal });
    } catch (error) {
      logger.warn(`[${topic}] 보정 요청 실패, 원래 글을 그대로 씁니다: ${error.message}`);
      break;
    }

    let repaired;
    try {
      repaired = normalize(reply.data, topic, settings, current.shape);
    } catch (error) {
      logger.warn(`[${topic}] 보정 결과를 읽지 못했습니다: ${error.message}`);
      break;
    }

    repaired.model = reply.model || current.model;
    repaired.costUsd = (current.costUsd || 0) + (reply.costUsd || 0);
    repaired.repairs = attempt;
    repaired.compliance = checkCompliance(repaired, settings);

    // 고친 결과가 더 나빠졌다면 되돌린다. (규칙 통과 개수로 판단)
    if (repaired.compliance.passed < current.compliance.passed) {
      logger.warn(`[${topic}] 보정 결과가 오히려 나빠져 이전 글을 유지합니다.`);
      break;
    }
    current = repaired;
    if (current.compliance.ok) {
      logger.info(`[${topic}] 보정 후 품질 검사를 통과했습니다. (${summarize(current.compliance)})`);
      break;
    }
  }

  return current;
}

export async function generatePost(topic, options = {}) {
  const settings = getSettings();
  const guideline = String(settings.post.extraGuideline || '').trim();
  const guidelineBlock = buildGuidelineBlock(guideline);
  const exampleBlock = buildExampleBlock();
  const systemPrompt = buildSystemPrompt(guideline);
  const { shape, count, needsChunking, openEnded } = detectShape(topic);

  logger.step(
    `[${topic}] 글 모양: ${
      { items: '항목별 상세형', table: '대형 비교표형', general: '정보 정리형' }[shape]
    }${count ? ` (${count}개 항목${openEnded ? ' 목표 — 개수를 안 밝힌 순위 글이라 넉넉히 잡았습니다' : ''})` : ''}`,
  );
  if (guideline) logger.info(`추가 지침 적용: ${guideline.replace(/\s+/g, ' ').slice(0, 120)}`);
  if (exampleBlock) logger.info('참고 예시를 프롬프트에 함께 넣었습니다.');
  if (count && count > ITEM_LIMIT) {
    logger.info(`항목이 ${count}개라 표를 나눠 받고 대표 항목만 상세하게 씁니다.`);
  }

  const canSearch = settings.claude.webSearch !== false;
  if (canSearch) {
    logger.info(`[${topic}] 자료를 검색해서 확인하며 씁니다. 이 단계가 1~3분 더 걸립니다.`);
  }

  const reply = await runClaudeJson(
    buildMainPrompt(topic, settings, { guidelineBlock, exampleBlock, shape, count, canSearch }),
    { systemPrompt, signal: options.signal, webSearch: canSearch },
  );

  let post = normalize(reply.data, topic, settings, shape);
  post.model = reply.model || '';
  post.costUsd = reply.costUsd || 0;

  // 큰 표는 본문과 따로, 구간을 나눠 받는다.
  if (needsChunking) {
    const headers = buildTableHeaders(post.table?.headers);

    const { rows, model, missing } = await generateTableRows({
      topic,
      headers,
      count,
      signal: options.signal,
      onProgress: options.onProgress,
    });

    const baseNote = '이 표는 공식 순위가 아니라 일반적으로 알려진 정보를 정리한 참고 자료이며, '
      + '최신 정보는 직접 확인하시기 바랍니다.';

    post.table = {
      heading: post.table?.heading || `${topic} 전체 정리`,
      headers,
      rows,
      note: missing.length
        ? `${baseNote} 확인할 수 있는 자료가 있는 ${rows.length}개까지 정리했습니다.`
        : (post.table?.note || baseNote),
    };
    post.model = post.model || model || '';
    post.tableExpected = count;
    post.tableMissing = missing;

    if (missing.length) {
      logger.warn(
        `표는 ${count}개를 목표로 했지만 자료가 확인되는 ${rows.length}개까지만 채웠습니다. `
        + '(빈 행을 지어내지 않고 그만큼만 남깁니다)',
      );
    } else {
      logger.info(`표 ${rows.length}개 행을 빠짐없이 채웠습니다.`);
    }
  }

  post = await repairUntilCompliant(post, {
    topic,
    settings,
    systemPrompt,
    signal: options.signal,
    onProgress: options.onCompliance,
  });

  return post;
}
