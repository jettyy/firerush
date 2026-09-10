export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(text, max = 40) {
  return String(text)
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max) || 'post';
}

/**
 * 엑셀에서 복사한 덩어리를 주제 목록으로 만든다.
 * 줄 단위로 자르고, 탭/여러 칸으로 나뉜 경우 첫 번째 열만 주제로 본다.
 */
export function parseTopics(raw = '') {
  const seen = new Set();
  const topics = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const cell = line.split('\t')[0].trim().replace(/^["']|["']$/g, '').trim();
    if (!cell) continue;
    // 엑셀 첫 줄이 머리글인 경우가 잦아서 걸러낸다.
    if (topics.length === 0 && /^(주제|제목|topic|title|키워드|keyword)$/i.test(cell)) continue;
    const key = cell.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(cell);
  }
  return topics;
}

export function nowIso() {
  return new Date().toISOString();
}

export function shortId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
