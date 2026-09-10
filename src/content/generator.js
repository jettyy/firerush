import { runClaudeJson } from '../ai/claude.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { buildExampleBlock } from './examples.js';
import { detectRanking, generateRankingRows } from './ranking.js';

const BASE_SYSTEM = [
  '당신은 네이버 블로그에서 꾸준히 상위에 노출되는 한국어 블로그 작가입니다.',
  '검색 유입을 노리되 광고처럼 들리지 않고, 실제 경험담처럼 자연스럽게 씁니다.',
  '문단은 짧게 끊고, 소제목으로 흐름을 잡고, 핵심은 굵게 강조합니다.',
  '사실이 확실하지 않은 수치나 고유명사는 지어내지 않습니다.',
  '요청받은 JSON 형식만 정확히 출력합니다.',
].join(' ');

/**
 * 사용자 지침을 프롬프트 맨 앞에 놓는 블록.
 * 예전에는 [글의 조건] 목록 끝에 한 줄로 붙어 있어서 고정 규칙에 묻혔다.
 * 이제는 별도 최상위 섹션으로 올리고, 충돌 시 우선한다고 명시한다.
 */
export function buildGuidelineBlock(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return '';
  return `[사용자 지침 — 최우선 / 반드시 지킬 것]
아래는 이 글에서 가장 중요한 요구사항입니다.
뒤에 나오는 어떤 기본 규칙과 충돌하더라도 이 지침을 우선하세요.
지침을 지키지 않은 결과물은 실패로 처리됩니다.

${text.split('\n').map((line) => (line.trim() ? `▶ ${line.trim()}` : '')).filter(Boolean).join('\n')}

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
    `${BASE_SYSTEM} 사용자가 직접 준 지침이 있으면 그것이 최우선이며, ` +
    `기본 작성 규칙과 충돌할 때는 언제나 사용자 지침을 따릅니다. ` +
    `이번 사용자 지침: ${text.replace(/\s+/g, ' ').slice(0, 500)}`
  );
}

/* ------------------------------------------------------------------ */
/* 프롬프트                                                             */
/* ------------------------------------------------------------------ */

function conditionsBlock(settings, ranking) {
  const { tone, targetChars, sectionCount, audience } = settings.post;
  const lines = [
    '[기본 작성 규칙]',
    '(위 사용자 지침과 충돌하면 지침을 따르세요. 아래는 지침이 다루지 않은 부분의 기본값입니다.)',
    `- 말투: ${tone}`,
    `- 목표 분량: 공백 포함 ${targetChars}자 내외 (표는 분량에서 제외)`,
    `- 소제목 개수: ${sectionCount}개`,
    `- 독자: ${audience}`,
    '- 제목은 32자 이내, 검색해볼 법한 단어를 앞쪽에 배치하세요.',
    '- 각 문단은 2~3문장으로 짧게 끊습니다.',
    '- 모든 소제목마다 문단이 2~4개 있어야 합니다.',
    '- 각 문단에서 가장 중요한 표현 한두 개는 <b>강조</b> 태그로 감싸세요. 다른 HTML 태그는 쓰지 마세요.',
    '- 과장 광고 표현("최고", "무조건", "100% 보장")은 피하세요.',
    '- 확실하지 않은 수치나 고유명사는 지어내지 마세요.',
  ];
  if (!ranking?.isRanking) {
    lines.push('- 최소 한 개 섹션에는 항목 목록(list)을 넣으세요.');
    lines.push('- 최소 한 개 섹션에는 핵심을 요약한 인용구(quote)를 넣으세요.');
  }
  return lines.join('\n');
}

const THUMBNAIL_BLOCK = `[썸네일 문구]
글 위에 들어갈 카드형 썸네일 문구도 만들어주세요.
- headline: 18자 이내, 한눈에 읽히는 굵은 문구
- subline: 30자 이내 보조 설명
- badge: 6자 이내 짧은 라벨 (예: "정리", "초보 가이드")
- style: bold, gradient, minimal, editorial 중 주제 분위기에 맞는 하나
- accent: 어두운 계열 HEX 색상 (흰 글씨가 올라갑니다)
- emoji: 주제를 상징하는 이모지 1개`;

/** 표를 한 번에 받아도 되는 보통 글용 프롬프트. */
function buildStandardPrompt(topic, settings, { guidelineBlock, exampleBlock, ranking }) {
  const tableHint = ranking?.isRanking
    ? `

[표 — 이 글에는 반드시 표가 들어갑니다]
- 순위/목록형 주제이므로 table 필드를 반드시 채우세요.
- ${ranking.count ? `정확히 ${ranking.count}개 행` : '주제가 요구하는 모든 항목'}을 빠짐없이 넣으세요.
- "이하 생략", "...", "(중략)" 같은 표현은 절대 쓰지 마세요.
- 설명 칸은 25자 이내로 짧게.`
    : `

[표 — 필요할 때만]
- 비교·순위·목록처럼 표가 더 읽기 좋은 내용이 있으면 table 필드를 채우세요.
- 필요 없으면 table 을 아예 빼세요.`;

  return `${guidelineBlock}주제: "${topic}"

위 주제로 네이버 블로그 글 한 편을 써주세요.

${conditionsBlock(settings, ranking)}
${tableHint}

${THUMBNAIL_BLOCK}
${exampleBlock ? `\n${exampleBlock}\n` : ''}
[출력 형식]
아래 JSON 객체 하나만 출력하세요. 설명이나 코드 펜스를 붙이지 마세요.

{
  "title": "글 제목",
  "summary": "한 줄 요약",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "guidelineCheck": "사용자 지침을 어떻게 반영했는지 한 줄 (지침이 없으면 빈 문자열)",
  "thumbnail": {
    "headline": "...", "subline": "...", "badge": "...",
    "style": "bold", "accent": "#1F3A93", "emoji": "📌"
  },
  "intro": ["도입 문단1", "도입 문단2"],
  "table": {
    "heading": "표 제목",
    "headers": ["순위", "항목", "설명"],
    "rows": [["1", "항목 이름", "짧은 설명"]],
    "note": "표 아래 붙일 짧은 안내 (없으면 빈 문자열)"
  },
  "sections": [
    {
      "heading": "소제목",
      "paragraphs": ["문단1", "문단2"],
      "list": ["항목1", "항목2"],
      "quote": "핵심 요약 한 문장"
    }
  ],
  "outro": ["마무리 문단1", "마무리 문단2"]
}

list, quote, table 은 필요할 때만 넣고 없으면 키를 생략하세요.${buildGuidelineReminder(settings.post.extraGuideline)}`;
}

/**
 * 큰 표가 필요한 글의 1단계: 표의 뼈대와 본문만 받는다.
 * 행은 ranking.js 가 구간을 나눠 따로 채운다.
 */
function buildStructurePrompt(topic, settings, { guidelineBlock, exampleBlock, ranking }) {
  return `${guidelineBlock}주제: "${topic}"

위 주제로 네이버 블로그 글을 씁니다.
이 글에는 **${ranking.count}개 항목이 모두 들어간 큰 표**가 하나 들어갑니다.
표의 내용(행)은 뒤에서 따로 채울 것이므로, **지금은 표의 뼈대만** 잡아주세요.

${conditionsBlock(settings, ranking)}

[표 뼈대]
- table.headers: 표의 열 이름 3~4개. 첫 열은 반드시 "순위".
  예) ["순위", "이름", "특징"] 또는 ["순위", "채널명", "구독자 규모", "주요 콘텐츠"]
- table.heading: 표 위에 붙일 소제목 (예: "${topic} 전체 정리")
- table.note: 표 아래 붙일 짧은 안내 한 줄
- rows 는 넣지 마세요. 비워두면 됩니다.

[본문]
- 표 앞뒤로 읽을거리가 있어야 합니다. 소제목 ${settings.post.sectionCount}개로 본문을 써주세요.
- 표에 다 담기지 않는 배경 설명, 고르는 기준, 상위 항목 짚어주기 같은 내용이 좋습니다.
- 본문에서 개별 항목을 나열하지는 마세요. 나열은 표가 담당합니다.

${THUMBNAIL_BLOCK}
${exampleBlock ? `\n${exampleBlock}\n` : ''}
[출력 형식]
아래 JSON 객체 하나만 출력하세요.

{
  "title": "글 제목",
  "summary": "한 줄 요약",
  "tags": ["태그1", "태그2", "태그3"],
  "guidelineCheck": "사용자 지침을 어떻게 반영했는지 한 줄 (지침이 없으면 빈 문자열)",
  "thumbnail": {
    "headline": "...", "subline": "...", "badge": "...",
    "style": "bold", "accent": "#1F3A93", "emoji": "📌"
  },
  "intro": ["도입 문단1", "도입 문단2"],
  "table": { "heading": "...", "headers": ["순위", "이름", "특징"], "note": "..." },
  "sections": [{ "heading": "소제목", "paragraphs": ["문단1", "문단2"] }],
  "outro": ["마무리 문단1"]
}${buildGuidelineReminder(settings.post.extraGuideline)}`;
}

/* ------------------------------------------------------------------ */
/* 응답 정규화                                                          */
/* ------------------------------------------------------------------ */

const STYLES = new Set(['bold', 'gradient', 'minimal', 'editorial']);

function toParagraphList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeTable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const headers = (Array.isArray(raw.headers) ? raw.headers : [])
    .map((header) => String(header ?? '').trim())
    .filter(Boolean);
  if (headers.length < 2) return null;

  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .map((row) => {
      const cells = Array.isArray(row)
        ? row.map((cell) => String(cell ?? '').trim())
        : (row && typeof row === 'object' ? Object.values(row).map((cell) => String(cell ?? '').trim()) : null);
      if (!cells) return null;
      const fixed = cells.slice(0, headers.length);
      while (fixed.length < headers.length) fixed.push('');
      return fixed;
    })
    .filter((row) => row && row.some((cell) => cell));

  return {
    heading: String(raw.heading || '').trim(),
    headers,
    rows,
    note: String(raw.note || '').trim(),
  };
}

function normalize(raw, topic, settings) {
  const title = String(raw.title || topic).trim().slice(0, 100);
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((section) => ({
      heading: String(section.heading || '').trim(),
      paragraphs: toParagraphList(section.paragraphs ?? section.body ?? section.content),
      list: toParagraphList(section.list ?? section.items),
      quote: String(section.quote || '').trim(),
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
    title,
    summary: String(raw.summary || '').trim(),
    guideline: String(settings.post.extraGuideline || '').trim(),
    guidelineCheck: String(raw.guidelineCheck || '').trim(),
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((tag) => String(tag).replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10),
    thumbnail: {
      headline: String(thumb.headline || title).trim().slice(0, 40),
      subline: String(thumb.subline || raw.summary || '').trim().slice(0, 60),
      badge: String(thumb.badge || '').trim().slice(0, 12),
      emoji: String(thumb.emoji || '').trim().slice(0, 4),
      style,
      accent,
    },
    intro: toParagraphList(raw.intro),
    table: normalizeTable(raw.table),
    sections,
    outro: toParagraphList(raw.outro),
    model: '',
    costUsd: 0,
  };

  if (!post.intro.length && post.sections.length) {
    // 도입부가 비면 썸네일이 들어갈 자리가 없어진다. 첫 문단을 끌어올린다.
    post.intro = post.sections[0].paragraphs.splice(0, 1);
  }
  if (!post.sections.length && !post.table?.rows.length) {
    throw new Error('AI 응답에 본문 섹션이 없습니다.');
  }
  return post;
}

export function countChars(post) {
  const parts = [
    ...post.intro,
    ...post.sections.flatMap((s) => [s.heading, ...s.paragraphs, ...s.list, s.quote]),
    ...post.outro,
  ];
  if (post.table) {
    parts.push(post.table.heading, post.table.note);
    for (const row of post.table.rows) parts.push(...row);
  }
  return parts.join('').replace(/<\/?b>/g, '').length;
}

/* ------------------------------------------------------------------ */
/* 생성                                                                */
/* ------------------------------------------------------------------ */

export async function generatePost(topic, options = {}) {
  const settings = getSettings();
  const guideline = String(settings.post.extraGuideline || '').trim();
  const guidelineBlock = buildGuidelineBlock(guideline);
  const exampleBlock = buildExampleBlock();
  const systemPrompt = buildSystemPrompt(guideline);
  const ranking = detectRanking(topic);

  if (guideline) logger.info(`추가 지침 적용: ${guideline.replace(/\s+/g, ' ').slice(0, 120)}`);
  if (exampleBlock) logger.info('참고 예시를 프롬프트에 함께 넣었습니다.');

  // 표가 큰 글은 뼈대와 행을 나눠 받는다. 한 번에 받으면 중간에 잘린다.
  if (ranking.needsChunking) {
    logger.step(`순위형 주제로 판단 (${ranking.count}개 항목). 표를 나눠서 받습니다.`);

    const structure = await runClaudeJson(
      buildStructurePrompt(topic, settings, { guidelineBlock, exampleBlock, ranking }),
      { systemPrompt, signal: options.signal },
    );

    const post = normalize(structure.data, topic, settings);
    const headers = post.table?.headers?.length >= 2
      ? post.table.headers
      : ['순위', '항목', '설명'];

    const { rows, model, missing } = await generateRankingRows({
      topic,
      headers,
      count: ranking.count,
      guidelineBlock,
      systemPrompt,
      signal: options.signal,
      onProgress: options.onProgress,
    });

    post.table = {
      heading: post.table?.heading || `${topic} 전체 정리`,
      headers,
      rows,
      note: post.table?.note || '',
    };
    post.model = structure.model || model || '';
    post.costUsd = structure.costUsd || 0;
    post.rankingExpected = ranking.count;
    post.rankingMissing = missing;

    if (missing.length) {
      logger.warn(`표에서 ${missing.length}개 순위를 끝내 채우지 못했습니다: ${missing.slice(0, 20).join(', ')}`);
    } else {
      logger.info(`표 ${rows.length}개 행을 빠짐없이 채웠습니다.`);
    }
    return post;
  }

  const reply = await runClaudeJson(
    buildStandardPrompt(topic, settings, { guidelineBlock, exampleBlock, ranking }),
    { systemPrompt, signal: options.signal },
  );
  const post = normalize(reply.data, topic, settings);
  post.model = reply.model || '';
  post.costUsd = reply.costUsd || 0;

  if (ranking.isRanking && ranking.count && post.table) {
    post.rankingExpected = ranking.count;
    post.rankingMissing = post.table.rows.length < ranking.count
      ? [`${post.table.rows.length}/${ranking.count}`]
      : [];
  }
  return post;
}
