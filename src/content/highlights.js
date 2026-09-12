/**
 * 본문 중간에 넣을 "강조 카드" 3장의 문구를 뽑아낸다.
 *
 * 실제 사진이나 일러스트를 새로 생성하지 않는다(추가 비용 0원, AI 호출도 늘리지 않는다).
 * 대신 이미 만들어진 글 구조(criteria/sections/table/outro)에서 그 지점의
 * 핵심 문장을 그대로 뽑아 카드에 옮긴다 — 광고 배너처럼 "핵심만 큼직하게" 보여주는 방식이다.
 *
 * 3장은 글의 1/5, 중간, 4/5 지점에 들어갈 것을 염두에 두고 고른다.
 *   1번 카드 (도입부 직후, 1/5 지점)  → 선정 기준 또는 첫 섹션의 핵심
 *   2번 카드 (중간)                   → 중간 섹션 또는 표의 대표 행
 *   3번 카드 (마무리 직전, 4/5 지점)   → 뒤쪽 섹션 또는 마무리 요약
 */

const LABELS = ['핵심 포인트', '중간 요약', '한눈에 정리'];

function trim(text, max) {
  const clean = String(text || '').replace(/<\/?b>/gi, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** 섹션 하나에서 카드용 짧은 문구를 뽑는다. */
function fromSection(section, headlineMax = 34) {
  if (!section) return null;
  const points = [];
  if (section.list?.length) points.push(...section.list);
  for (const sub of section.subsections || []) {
    if (sub.list?.length) points.push(...sub.list);
    else if (sub.heading) points.push(sub.heading);
  }
  if (!points.length && section.paragraphs?.length) points.push(section.paragraphs[0]);

  return {
    headline: trim(section.heading || section.paragraphs?.[0] || '', headlineMax),
    points: points.slice(0, 3).map((p) => trim(p, 46)),
  };
}

/** 표에서 대표 행 몇 개를 카드용 목록으로 뽑는다. */
function fromTable(table) {
  if (!table?.rows?.length) return null;
  const picked = table.rows.slice(0, 3).map((row) => trim(row.slice(0, 2).join(' · '), 44));
  return { headline: trim(table.heading || '한눈에 보는 비교표', 34), points: picked };
}

function fromCriteria(criteria) {
  if (!criteria) return null;
  return {
    headline: trim(criteria.heading || '이렇게 골랐습니다', 34),
    points: (criteria.items?.length ? criteria.items : criteria.paragraphs).slice(0, 3).map((p) => trim(p, 44)),
  };
}

function fromOutro(outro) {
  if (!outro?.length) return null;
  return { headline: trim(outro[0], 40), points: outro.slice(1, 3).map((p) => trim(p, 44)) };
}

/**
 * 3장을 만든다. 각 카드는 { label, headline, points } 형태.
 * 후보가 부족하면(섹션이 1~2개뿐인 짧은 글 등) 있는 것 안에서 최대한 채우고,
 * 그래도 안 되면 그 자리는 건너뛴다 — 억지로 지어내지 않는다.
 */
export function buildHighlightCards(post) {
  const sections = post.sections || [];
  const mid = sections[Math.floor(sections.length / 2)];
  const late = sections[sections.length - 1];

  const candidates = [
    fromCriteria(post.criteria) || fromSection(sections[0]),
    fromTable(post.table) || fromSection(mid),
    fromOutro(post.outro) || fromSection(late),
  ];

  const used = new Set();
  return candidates
    .map((card, index) => {
      if (!card || !card.headline) return null;
      const key = card.headline;
      if (used.has(key)) return null;   // 같은 내용을 두 번 보여주지 않는다.
      used.add(key);
      return { label: LABELS[index], headline: card.headline, points: card.points.filter(Boolean) };
    });
}
