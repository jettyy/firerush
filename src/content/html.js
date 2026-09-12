import { escapeHtml } from '../lib/util.js';

/**
 * AI 는 문단 안에서 <b> 만 쓰도록 지시받는다.
 * 그래서 전부 이스케이프한 뒤 <b> 만 되살려 태그 주입을 막는다.
 */
function inline(text) {
  return escapeHtml(text)
    .replace(/&lt;b&gt;/gi, '<b>')
    .replace(/&lt;\/b&gt;/gi, '</b>');
}

/**
 * 모든 요소에 글자색을 직접 박아둔다.
 * 색을 비워두면 에디터가 바로 앞 블록의 색을 물려받아서,
 * 표 아래 회색 안내문 다음부터 본문 전체가 회색으로 나온다.
 */
const BLACK = '#000000';
const P = `margin:0 0 14px 0; line-height:1.9; font-size:16px; color:${BLACK}; text-align:left;`;
const SPACER = `<p style="color:${BLACK}; text-align:left;"><br></p>`;

function paragraph(text) {
  return `<p style="${P}">${inline(text)}</p>`;
}

function heading(text) {
  return (
    `<p style="margin:34px 0 14px 0; line-height:1.6; font-size:19px; font-weight:700; ` +
    `color:${BLACK}; text-align:left;">${inline(text)}</p>`
  );
}

/** 세부 소제목(H3 격). 메인 소제목보다 한 단계 작고, 왼쪽에 색 띠를 둔다. */
function subheading(text) {
  return (
    `<p style="margin:22px 0 10px 0; padding-left:10px; border-left:3px solid #03c75a; ` +
    `line-height:1.5; font-size:16.5px; font-weight:700; color:${BLACK}; text-align:left;">` +
    `${inline(text)}</p>`
  );
}

function quote(text) {
  return (
    `<blockquote style="margin:20px 0; padding:12px 18px; border-left:4px solid #03c75a; ` +
    `background:#f7f9f8; line-height:1.8; font-size:16px; color:${BLACK}; ` +
    `text-align:left;">${inline(text)}</blockquote>`
  );
}

function list(items) {
  const li = items
    .map((item) => (
      `<li style="margin:0 0 8px 0; line-height:1.8; font-size:16px; color:${BLACK}; ` +
      `text-align:left;">${inline(item)}</li>`
    ))
    .join('');
  return `<ul style="margin:16px 0 20px 0; padding-left:22px; color:${BLACK};">${li}</ul>`;
}

const divider = () => `<p style="text-align:center; margin:26px 0; color:#c0c6cc;">• • •</p>`;

/** 순위표 등. 네이버 에디터는 붙여넣은 <table> 을 표 컴포넌트로 바꿔준다. */
export function buildTableHtml(table) {
  if (!table?.headers?.length || !table.rows?.length) return '';

  const th = table.headers
    .map((header) => (
      `<th style="border:1px solid #d8dee4; padding:9px 10px; background:#f3f6f8; ` +
      `font-size:15px; font-weight:700; text-align:left; color:${BLACK};">${inline(header)}</th>`
    ))
    .join('');

  const trs = table.rows
    .map((row, index) => {
      const tds = row
        .map((cell, column) => (
          `<td style="border:1px solid #d8dee4; padding:8px 10px; font-size:15px; ` +
          `line-height:1.6; color:${BLACK};` +
          `${column === 0 ? ' text-align:center; font-weight:600;' : ''}">` +
          `${inline(cell)}</td>`
        ))
        .join('');
      const stripe = index % 2 === 1 ? ' style="background:#fafbfc;"' : '';
      return `<tr${stripe}>${tds}</tr>`;
    })
    .join('');

  const parts = [];
  if (table.heading) parts.push(heading(table.heading));
  parts.push(
    `<table border="1" cellspacing="0" cellpadding="6" ` +
    `style="border-collapse:collapse; width:100%; margin:16px 0; color:${BLACK};">` +
    `<thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`,
  );
  if (table.note) {
    parts.push(
      `<p style="margin:10px 0 0 0; font-size:14px; color:#7a8590; line-height:1.7; ` +
      `text-align:left;">${inline(table.note)}</p>`,
    );
    // 회색 안내문 뒤에 검정 문단을 하나 둬서 다음 블록이 회색을 물려받지 않게 한다.
    parts.push(SPACER);
  }
  return parts.join('');
}

/** 서두의 "선정 기준" 단락. */
function criteriaHtml(criteria) {
  if (!criteria) return '';
  const blocks = [heading(criteria.heading || '추천 항목을 고른 기준')];
  criteria.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (criteria.items?.length) blocks.push(list(criteria.items));
  return blocks.join(SPACER);
}

/** 썸네일 앞에 들어갈 도입부. */
export function buildIntroHtml(post) {
  return post.intro.map(paragraph).join(SPACER);
}

function subsectionHtml(sub) {
  const blocks = [subheading(sub.heading)];
  sub.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (sub.list?.length) blocks.push(list(sub.list));
  return blocks.join(SPACER);
}

function sectionHtml(section) {
  const blocks = [];
  if (section.heading) blocks.push(heading(section.heading));
  section.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (section.list?.length) blocks.push(list(section.list));
  for (const sub of section.subsections || []) blocks.push(subsectionHtml(sub));
  if (section.quote) blocks.push(quote(section.quote));
  return blocks.join(SPACER);
}

/**
 * 붙여넣기 블록 사이에 넣는 빈 문단.
 *
 * 에디터는 붙여넣은 HTML 의 첫 문단을 커서가 있던 문단에 합쳐버린다.
 * 그래서 블록 맨 앞에 빈 문단을 하나 두어 그게 대신 합쳐지게 하고,
 * 진짜 내용은 제 서식을 지닌 새 문단으로 들어가게 한다.
 */
export const BLOCK_GAP = SPACER;

/**
 * 본문을 "조각" 단위로 쪼갠 배열. (선정 기준 → 섹션들 → 표 → 마무리 → 태그)
 * 조각 하나는 붙여넣기 경계로 쪼개도 안전한 단위다.
 */
function bodyPieces(post) {
  const pieces = [];
  const tableHtml = buildTableHtml(post.table);

  if (post.criteria) pieces.push(criteriaHtml(post.criteria));

  post.sections.forEach((section, index) => {
    if (index > 0) pieces.push(divider());
    pieces.push(sectionHtml(section));
    // 첫 섹션(배경 설명) 다음이 표가 들어가기 가장 자연스러운 자리다.
    if (index === 0 && tableHtml) pieces.push(tableHtml);
  });
  if (tableHtml && !post.sections.length) pieces.push(tableHtml);

  if (post.outro.length) {
    pieces.push(divider());
    pieces.push(post.outro.map(paragraph).join(SPACER));
  }
  if (post.tags.length) {
    pieces.push(paragraph(post.tags.map((tag) => `#${tag}`).join(' ')));
  }
  return pieces.filter(Boolean);
}

/** 썸네일 뒤에 들어갈 본문 전체 (미리보기·백업용, 이미지 없이 순수 텍스트). */
export function buildBodyHtml(post) {
  return bodyPieces(post).join(SPACER);
}

/**
 * 본문을 붙여넣기 단위로 쪼갠 배열. (이미지 없는 글, 또는 표만 있는 글용 — 옛 방식)
 * 표가 있으면 [표 앞] · [표] · [표 뒤] 세 덩어리로, 없으면 통째로 한 번에 붙인다.
 * buildBodyPlan 을 쓰지 않는 호출부(있다면)를 위해 남겨둔다.
 */
export function buildBodyBlocks(post) {
  const pieces = bodyPieces(post);
  const tableHtml = buildTableHtml(post.table);
  const tableIndex = tableHtml ? pieces.indexOf(tableHtml) : -1;

  if (tableIndex === -1) return [pieces.join(SPACER)].filter(Boolean);
  return [
    pieces.slice(0, tableIndex).join(SPACER),
    pieces[tableIndex],
    pieces.slice(tableIndex + 1).join(SPACER),
  ].filter(Boolean);
}

/**
 * 어느 조각 다음에 이미지를 끼워 넣을지 정한다.
 * 글 전체(조각 개수 기준) 의 1/5, 중간, 4/5 지점을 목표로 하되,
 * 서로 겹치면 뒤쪽 지점을 한 칸씩 밀어 최대한 갈라놓는다.
 */
function pickInsertionPoints(total) {
  const fractions = [0.2, 0.5, 0.8];
  const points = [];
  for (const fraction of fractions) {
    const raw = Math.min(total - 1, Math.max(1, Math.round(fraction * total)));
    const value = points.length && raw <= points[points.length - 1]
      ? points[points.length - 1] + 1
      : raw;
    points.push(value < total ? value : null);
  }
  return points;
}

/**
 * 본문을 [글 조각 ↔ 강조 카드 이미지] 가 번갈아 오는 계획으로 만든다.
 * 카드는 글 구조에서 뽑아낸 문구를 담은 이미지 3장으로, 1/5·중간·4/5 지점에 들어간다.
 * (카드 자체는 src/content/highlights.js + thumbnail.js 의 renderContentImages 가 만든다)
 *
 * @param {object} post
 * @param {Array<boolean>} cardAvailable 길이 3. 그 자리에 실제로 쓸 카드 이미지가 있는지.
 * @returns {Array<{type:'html', html:string} | {type:'image', cardIndex:number}>}
 */
export function buildBodyPlan(post, cardAvailable = [false, false, false]) {
  const pieces = bodyPieces(post);
  if (!pieces.length) return [];

  const points = pickInsertionPoints(pieces.length);
  const slots = points
    .map((point, cardIndex) => (point !== null && cardAvailable[cardIndex] ? { point, cardIndex } : null))
    .filter(Boolean)
    .sort((a, b) => a.point - b.point);

  const plan = [];
  let cursor = 0;
  for (const slot of slots) {
    const segment = pieces.slice(cursor, slot.point);
    if (segment.length) plan.push({ type: 'html', html: segment.join(SPACER) });
    plan.push({ type: 'image', cardIndex: slot.cardIndex });
    cursor = slot.point;
  }
  const rest = pieces.slice(cursor);
  if (rest.length) plan.push({ type: 'html', html: rest.join(SPACER) });

  return plan;
}

/** 클립보드에는 text/html 과 text/plain 을 같이 넣어야 붙여넣기가 안정적이다. */
export function htmlToPlainText(html) {
  return html
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\t\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 미리보기·백업용 단일 HTML 문서. */
export function buildPreviewHtml(post, thumbnailSrc = '') {
  const image = thumbnailSrc
    ? `<p style="margin:24px 0;"><img src="${escapeHtml(thumbnailSrc)}" style="max-width:100%;" alt="${escapeHtml(post.title)}"></p>`
    : '';
  const meta = [];
  if (post.guideline) {
    meta.push(`<b>적용된 추가 지침</b><br>${escapeHtml(post.guideline).replace(/\n/g, '<br>')}`);
  }
  if (post.guidelineCheck) meta.push(`<b>AI 자체 확인</b><br>${escapeHtml(post.guidelineCheck)}`);
  if (post.model) meta.push(`<b>사용 모델</b> ${escapeHtml(post.model)}`);
  if (post.compliance) {
    const rows = post.compliance.results
      .map((result) => `${result.ok ? '통과' : '미통과'} · ${escapeHtml(result.label)} — ${escapeHtml(result.detail)}`)
      .join('<br>');
    meta.push(`<b>품질 검사 (${post.compliance.passed}/${post.compliance.total})</b><br>${rows}`);
  }
  const metaBox = meta.length
    ? `<div style="margin:0 0 24px 0; padding:12px 16px; background:#f3f6f8; border-radius:8px; font-size:13px; color:#5b6773; line-height:1.8;">${meta.join('<br><br>')}</div>`
    : '';

  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${escapeHtml(post.title)}</title>`,
    '<div style="max-width:760px; margin:40px auto; padding:0 20px; font-family:\'Pretendard\',\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif; color:#1a1a1a;">',
    `<h1 style="font-size:28px; line-height:1.4; margin:0 0 24px 0;">${escapeHtml(post.title)}</h1>`,
    metaBox,
    buildIntroHtml(post),
    image,
    buildBodyHtml(post),
    '</div>',
  ].join('\n');
}
