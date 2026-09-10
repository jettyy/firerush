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
const P = `margin:0 0 14px 0; line-height:1.9; font-size:16px; color:${BLACK};`;
const SPACER = `<p style="color:${BLACK};"><br></p>`;

function paragraph(text) {
  return `<p style="${P}">${inline(text)}</p>`;
}

function heading(text) {
  return (
    `<p style="margin:34px 0 14px 0; line-height:1.6; font-size:19px; font-weight:700; ` +
    `color:${BLACK};">${inline(text)}</p>`
  );
}

function quote(text) {
  return (
    `<blockquote style="margin:20px 0; padding:12px 18px; border-left:4px solid #03c75a; ` +
    `background:#f7f9f8; line-height:1.8; font-size:16px; color:${BLACK};">${inline(text)}</blockquote>`
  );
}

function list(items) {
  const li = items
    .map((item) => (
      `<li style="margin:0 0 8px 0; line-height:1.8; font-size:16px; color:${BLACK};">` +
      `${inline(item)}</li>`
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
      `<p style="margin:10px 0 0 0; font-size:14px; color:#7a8590; line-height:1.7;">` +
      `${inline(table.note)}</p>`,
    );
    // 회색 안내문 뒤에 검정 문단을 하나 둬서 다음 블록이 회색을 물려받지 않게 한다.
    parts.push(SPACER);
  }
  return parts.join('');
}

/** 썸네일 앞에 들어갈 도입부. */
export function buildIntroHtml(post) {
  return post.intro.map(paragraph).join(SPACER);
}

function sectionHtml(section) {
  const blocks = [];
  if (section.heading) blocks.push(heading(section.heading));
  section.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (section.list?.length) blocks.push(list(section.list));
  if (section.quote) blocks.push(quote(section.quote));
  return blocks.join(SPACER);
}

/**
 * 본문을 붙여넣기 단위로 쪼갠 배열.
 * 100행짜리 표가 있는 글은 한 번에 밀어 넣으면 에디터가 버거워하므로
 * 섹션 단위로 나눠서 순서대로 붙인다.
 */
export function buildBodyBlocks(post) {
  const blocks = [];
  const tableHtml = buildTableHtml(post.table);
  let tablePlaced = false;

  post.sections.forEach((section, index) => {
    if (index > 0) blocks.push(divider());
    blocks.push(sectionHtml(section));
    // 첫 섹션(배경 설명) 다음이 표가 들어가기 가장 자연스러운 자리다.
    if (index === 0 && tableHtml) {
      blocks.push(tableHtml);
      tablePlaced = true;
    }
  });

  if (tableHtml && !tablePlaced) blocks.push(tableHtml);

  if (post.outro.length) {
    blocks.push(divider());
    blocks.push(post.outro.map(paragraph).join(SPACER));
  }

  if (post.tags.length) {
    blocks.push(paragraph(post.tags.map((tag) => `#${tag}`).join(' ')));
  }

  return blocks.filter(Boolean);
}

/** 썸네일 뒤에 들어갈 본문 전체 (미리보기·백업용). */
export function buildBodyHtml(post) {
  return buildBodyBlocks(post).join(SPACER);
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
  const guideline = post.guideline
    ? `<div style="margin:0 0 24px 0; padding:12px 16px; background:#f3f6f8; border-radius:8px; font-size:13px; color:#5b6773;">
         <b>적용된 추가 지침</b><br>${escapeHtml(post.guideline)}
         ${post.guidelineCheck ? `<br><br><b>AI 자체 확인</b><br>${escapeHtml(post.guidelineCheck)}` : ''}
         ${post.model ? `<br><br><b>사용 모델</b> ${escapeHtml(post.model)}` : ''}
       </div>`
    : (post.model
      ? `<div style="margin:0 0 24px 0; font-size:13px; color:#7a8590;">사용 모델: ${escapeHtml(post.model)}</div>`
      : '');

  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${escapeHtml(post.title)}</title>`,
    '<div style="max-width:760px; margin:40px auto; padding:0 20px; font-family:\'Pretendard\',\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif; color:#1a1a1a;">',
    `<h1 style="font-size:28px; line-height:1.4; margin:0 0 24px 0;">${escapeHtml(post.title)}</h1>`,
    guideline,
    buildIntroHtml(post),
    image,
    buildBodyHtml(post),
    '</div>',
  ].join('\n');
}
