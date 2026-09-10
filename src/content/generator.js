import { runClaudeJson } from '../ai/claude.js';
import { getSettings } from '../lib/settings.js';

const SYSTEM_PROMPT = [
  '당신은 네이버 블로그에서 꾸준히 상위에 노출되는 한국어 블로그 작가입니다.',
  '검색 유입을 노리되 광고처럼 들리지 않고, 실제 경험담처럼 자연스럽게 씁니다.',
  '문단은 짧게 끊고, 소제목으로 흐름을 잡고, 핵심은 굵게 강조합니다.',
  '사실이 확실하지 않은 수치나 고유명사는 지어내지 않습니다.',
  '요청받은 JSON 형식만 정확히 출력합니다.',
].join(' ');

function buildPrompt(topic, settings) {
  const { tone, targetChars, sectionCount, audience, extraGuideline } = settings.post;

  return `주제: "${topic}"

위 주제로 네이버 블로그 글 한 편을 써주세요.

[글의 조건]
- 말투: ${tone}
- 목표 분량: 공백 포함 ${targetChars}자 내외 (±20%)
- 소제목 개수: ${sectionCount}개
- 독자: ${audience}
- 제목은 32자 이내, 검색해볼 법한 단어를 앞쪽에 배치하고 클릭하고 싶게 만드세요.
- 각 문단은 2~3문장으로 짧게 끊습니다. 긴 문단은 만들지 마세요.
- 모든 소제목마다 문단이 2~4개 있어야 합니다.
- 최소 한 개 섹션에는 번호나 항목으로 정리한 목록(list)을 넣으세요.
- 최소 한 개 섹션에는 핵심을 요약한 인용구(quote)를 넣으세요.
- 각 문단에서 가장 중요한 표현 한두 개는 <b>강조</b> 태그로 감싸세요. 다른 HTML 태그는 쓰지 마세요.
- 과장 광고 표현("최고", "무조건", "100% 보장")은 피하세요.
${extraGuideline ? `- 추가 지침: ${extraGuideline}` : ''}

[썸네일 문구]
글 위에 들어갈 카드형 썸네일에 쓸 문구도 함께 만들어주세요.
- headline: 18자 이내, 한눈에 읽히는 굵은 문구
- subline: 30자 이내 보조 설명
- badge: 6자 이내 짧은 라벨 (예: "정리", "초보 가이드")
- style: bold, gradient, minimal, editorial 중 주제 분위기에 맞는 하나
- accent: 주제와 어울리는 진한 색상 HEX 코드 (밝은 흰 글씨가 올라가므로 어두운 계열)
- emoji: 주제를 상징하는 이모지 1개

[출력 형식]
아래 JSON 객체 하나만 출력하세요. 설명이나 코드 펜스를 붙이지 마세요.

{
  "title": "글 제목",
  "summary": "한 줄 요약",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "thumbnail": {
    "headline": "...",
    "subline": "...",
    "badge": "...",
    "style": "bold",
    "accent": "#1F3A93",
    "emoji": "📌"
  },
  "intro": ["도입 문단1", "도입 문단2"],
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

list 와 quote 는 필요한 섹션에만 넣고, 없으면 키를 생략하세요.`;
}

const STYLES = new Set(['bold', 'gradient', 'minimal', 'editorial']);

function toParagraphList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/** AI 응답이 조금씩 달라도 뒤 단계가 깨지지 않도록 모양을 맞춘다. */
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
    sections,
    outro: toParagraphList(raw.outro),
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

export function countChars(post) {
  const parts = [
    ...post.intro,
    ...post.sections.flatMap((s) => [s.heading, ...s.paragraphs, ...s.list, s.quote]),
    ...post.outro,
  ];
  return parts.join('').replace(/<\/?b>/g, '').length;
}

export async function generatePost(topic, options = {}) {
  const settings = getSettings();
  const raw = await runClaudeJson(buildPrompt(topic, settings), {
    systemPrompt: SYSTEM_PROMPT,
    signal: options.signal,
  });
  return normalize(raw, topic, settings);
}
