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

const P = 'margin:0 0 14px 0; line-height:1.9; font-size:16px;';
const SPACER = '<p><br></p>';

function paragraph(text) {
  return `<p style="${P}">${inline(text)}</p>`;
}

function heading(text) {
  return (
    `<p style="margin:34px 0 14px 0; line-height:1.6; font-size:19px; font-weight:700;">` +
    `${inline(text)}</p>`
  );
}

function quote(text) {
  return (
    `<blockquote style="margin:20px 0; padding:12px 18px; border-left:4px solid #03c75a; ` +
    `background:#f7f9f8; line-height:1.8; font-size:16px;">${inline(text)}</blockquote>`
  );
}

function list(items) {
  const li = items
    .map((item) => `<li style="margin:0 0 8px 0; line-height:1.8; font-size:16px;">${inline(item)}</li>`)
    .join('');
  return `<ul style="margin:16px 0 20px 0; padding-left:22px;">${li}</ul>`;
}

const divider = () => `<p style="text-align:center; margin:26px 0; color:#c0c6cc;">• • •</p>`;

/** 썸네일 앞에 들어갈 도입부. */
export function buildIntroHtml(post) {
  return post.intro.map(paragraph).join(SPACER);
}

/** 썸네일 뒤에 들어갈 본문 전체. */
export function buildBodyHtml(post) {
  const blocks = [];

  post.sections.forEach((section, index) => {
    if (index > 0) blocks.push(divider());
    if (section.heading) blocks.push(heading(section.heading));
    section.paragraphs.forEach((text) => blocks.push(paragraph(text)));
    if (section.list?.length) blocks.push(list(section.list));
    if (section.quote) blocks.push(quote(section.quote));
  });

  if (post.outro.length) {
    blocks.push(divider());
    post.outro.forEach((text) => blocks.push(paragraph(text)));
  }

  if (post.tags.length) {
    blocks.push(SPACER);
    blocks.push(paragraph(post.tags.map((tag) => `#${tag}`).join(' ')));
  }

  return blocks.join(SPACER);
}

/** 클립보드에는 text/html 과 text/plain 을 같이 넣어야 붙여넣기가 안정적이다. */
export function htmlToPlainText(html) {
  return html
    .replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 미리보기·백업용 단일 HTML 문서. */
export function buildPreviewHtml(post, thumbnailSrc = '') {
  const image = thumbnailSrc
    ? `<p style="margin:24px 0;"><img src="${escapeHtml(thumbnailSrc)}" style="max-width:100%;" alt="${escapeHtml(post.title)}"></p>`
    : '';
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${escapeHtml(post.title)}</title>`,
    '<div style="max-width:720px; margin:40px auto; padding:0 20px; font-family:\'Pretendard\',\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif; color:#1a1a1a;">',
    `<h1 style="font-size:28px; line-height:1.4; margin:0 0 24px 0;">${escapeHtml(post.title)}</h1>`,
    buildIntroHtml(post),
    image,
    buildBodyHtml(post),
    '</div>',
  ].join('\n');
}
