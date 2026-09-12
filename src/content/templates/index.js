import { escapeHtml } from '../../lib/util.js';

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) + amount);
  const g = clamp(((n >> 8) & 255) + amount);
  const b = clamp((n & 255) + amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const FONT = `'Pretendard','Pretendard Variable','Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic','Nanum Gothic',sans-serif`;

function shell(width, height, body, extraCss = '') {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; overflow:hidden; }
  body { font-family:${FONT}; -webkit-font-smoothing:antialiased; }
  .card { width:${width}px; height:${height}px; display:flex; position:relative; overflow:hidden; }
  .badge { display:inline-block; font-size:${Math.round(height * 0.036)}px; font-weight:800;
           letter-spacing:0.02em; padding:${Math.round(height * 0.018)}px ${Math.round(height * 0.038)}px;
           border-radius:999px; }
  .headline { font-weight:900; letter-spacing:-0.03em; word-break:keep-all; }
  .subline { font-weight:500; word-break:keep-all; }
  ${extraCss}
</style></head><body>${body}</body></html>`;
}

/**
 * 화면 하단을 가로지르는 강조 띠.
 * 실제 광고 배너처럼 "제목 + 한 번 더 강한 문구" 두 단으로 만들어
 * 클릭을 유도하는 썸네일 관례를 흉내낸다. 사진 없이도 이 구조만으로 시선을 끈다.
 */
function bottomBar({ text, height, width, bg, color, accentDark }) {
  if (!text) return '';
  return `
  <div style="position:absolute; left:0; right:0; bottom:0; width:${width}px;
              background:${bg}; padding:${height * 0.045}px ${height * 0.09}px;
              display:flex; align-items:center; gap:${height * 0.02}px;
              border-top:${Math.max(2, height * 0.006)}px solid ${accentDark};">
    <div style="width:${height * 0.05}px; height:${height * 0.05}px; flex:none; border-radius:6px;
                background:${accentDark}; display:flex; align-items:center; justify-content:center;
                color:#fff; font-size:${height * 0.032}px; font-weight:900;">›</div>
    <div style="font-weight:800; font-size:${height * 0.045}px; line-height:1.35; color:${color};
                word-break:keep-all;">${escapeHtml(text)}</div>
  </div>`;
}

/** 별·점 같은 작은 반짝임 장식. 배경이 밋밋해 보이지 않게 흩뿌린다. */
function sparkles(accent, height) {
  const dots = [
    [8, 10], [88, 14], [92, 34], [6, 46], [82, 66],
  ];
  return dots.map(([left, top], index) => (
    `<div style="position:absolute; left:${left}%; top:${top}%; font-size:${height * (index % 2 ? 0.028 : 0.02)}px;
                 color:${shade(accent, 90)}; opacity:.55;">✦</div>`
  )).join('');
}

/** 진한 단색 배경 + 큰 글씨 + 하단 강조 띠. 정보성 글에 무난하다. */
function bold({ headline, subline, badge, emoji, accent, width, height }) {
  const barSpace = subline ? height * 0.22 : 0;
  return shell(width, height, `
  <div class="card" style="background:${accent}; flex-direction:column; justify-content:center;
       padding:${height * 0.1}px ${height * 0.11}px ${height * 0.1 + barSpace}px;">
    <div style="position:absolute; right:${-height * 0.14}px; top:${-height * 0.2}px;
                width:${height * 0.66}px; height:${height * 0.66}px; border-radius:50%;
                background:${shade(accent, 26)};"></div>
    <div style="position:absolute; right:${height * 0.1}px; bottom:${barSpace + height * 0.06}px;
                width:${height * 0.32}px; height:${height * 0.32}px; border-radius:50%;
                background:${shade(accent, 16)};"></div>
    ${sparkles(accent, height)}
    <div style="position:relative;">
      ${badge ? `<div class="badge" style="background:rgba(255,255,255,0.2); color:#fff; margin-bottom:${height * 0.06}px;">${escapeHtml(badge)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.15}px; line-height:1.2; color:#fff; text-shadow:0 3px 16px rgba(0,0,0,0.22);">
        ${emoji ? `<span style="margin-right:0.18em;">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(headline)}
      </div>
    </div>
  </div>
  ${bottomBar({ text: subline, height, width, bg: '#ffffff', color: shade(accent, -40), accentDark: shade(accent, -20) })}`);
}

/** 사선 그라데이션. 감성적인 주제나 후기성 글에 어울린다. */
function gradient({ headline, subline, badge, emoji, accent, width, height }) {
  const barSpace = subline ? height * 0.22 : 0;
  return shell(width, height, `
  <div class="card" style="background:linear-gradient(135deg, ${shade(accent, -28)} 0%, ${accent} 48%, ${shade(accent, 62)} 100%);
       flex-direction:column; justify-content:flex-end;
       padding:${height * 0.1}px ${height * 0.1}px ${height * 0.08 + barSpace}px;">
    <div style="position:absolute; inset:0; background:
         radial-gradient(circle at 78% 22%, rgba(255,255,255,0.26) 0%, rgba(255,255,255,0) 46%);"></div>
    ${sparkles(accent, height)}
    <div style="position:relative;">
      ${emoji ? `<div style="font-size:${height * 0.12}px; margin-bottom:${height * 0.03}px;">${escapeHtml(emoji)}</div>` : ''}
      ${badge ? `<div class="badge" style="background:#fff; color:${shade(accent, -30)}; margin-bottom:${height * 0.045}px;">${escapeHtml(badge)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.14}px; line-height:1.22; color:#fff; text-shadow:0 3px 20px rgba(0,0,0,0.2);">
        ${escapeHtml(headline)}
      </div>
    </div>
  </div>
  ${bottomBar({ text: subline, height, width, bg: '#14161a', color: '#ffffff', accentDark: shade(accent, 40) })}`);
}

/** 흰 배경 + 얇은 테두리 + 하단 강조 띠. 깔끔하고 어떤 주제에도 무난하다. */
function minimal({ headline, subline, badge, emoji, accent, width, height }) {
  const barSpace = subline ? height * 0.2 : 0;
  return shell(width, height, `
  <div class="card" style="background:#fff; padding:${height * 0.06}px ${height * 0.06}px ${barSpace + height * 0.06}px;">
    <div style="flex:1; border:${Math.max(2, height * 0.005)}px solid ${accent}; border-radius:${height * 0.03}px;
                display:flex; flex-direction:column; justify-content:center; padding:${height * 0.09}px; position:relative;">
      <div style="position:absolute; left:0; top:${height * 0.12}px; bottom:${height * 0.12}px;
                  width:${height * 0.016}px; background:${accent};"></div>
      ${badge ? `<div class="badge" style="background:${accent}; color:#fff; align-self:flex-start; margin-bottom:${height * 0.055}px;">${escapeHtml(badge)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.13}px; line-height:1.26; color:#14171a;">
        ${escapeHtml(headline)}${emoji ? `<span style="margin-left:0.2em;">${escapeHtml(emoji)}</span>` : ''}
      </div>
    </div>
  </div>
  ${subline ? `<div style="position:absolute; left:0; right:0; bottom:0; width:${width}px;
       background:${accent}; padding:${height * 0.05}px ${height * 0.1}px;
       display:flex; align-items:center;">
       <div style="font-weight:800; font-size:${height * 0.042}px; line-height:1.35; color:#fff;
                   word-break:keep-all;">${escapeHtml(subline)}</div>
     </div>` : ''}`);
}

/** 잡지 표지풍. 좌측 컬러 블록 + 우측 큰 제목 + 하단 강조 띠. */
function editorial({ headline, subline, badge, emoji, accent, width, height }) {
  const barSpace = subline ? height * 0.18 : 0;
  return shell(width, height, `
  <div class="card" style="background:#f4f1ec;">
    <div style="width:${width * 0.28}px; background:${accent}; display:flex; align-items:center;
                justify-content:center; position:relative;">
      <div style="font-size:${height * 0.22}px;">${escapeHtml(emoji || '✦')}</div>
      ${sparkles(accent, height)}
    </div>
    <div style="flex:1; display:flex; flex-direction:column; justify-content:center;
                padding:${height * 0.08}px ${height * 0.08}px ${barSpace + height * 0.08}px;">
      ${badge ? `<div style="font-size:${height * 0.04}px; font-weight:800; letter-spacing:0.16em; color:${accent}; margin-bottom:${height * 0.035}px;">${escapeHtml(badge.toUpperCase())}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.11}px; line-height:1.28; color:#1b1a17;">${escapeHtml(headline)}</div>
      <div style="width:${height * 0.16}px; height:${Math.max(3, height * 0.006)}px; background:${accent}; margin:${height * 0.045}px 0;"></div>
    </div>
  </div>
  ${subline ? `<div style="position:absolute; left:0; right:0; bottom:0; width:${width}px;
       background:#1b1a17; padding:${height * 0.045}px ${height * 0.09}px;
       display:flex; align-items:center;">
       <div style="font-weight:700; font-size:${height * 0.038}px; line-height:1.4; color:#fff;
                   word-break:keep-all;">${escapeHtml(subline)}</div>
     </div>` : ''}`);
}

export const TEMPLATES = { bold, gradient, minimal, editorial };

export function renderTemplate(spec) {
  const build = TEMPLATES[spec.style] || TEMPLATES.bold;
  return build(spec);
}

/* ------------------------------------------------------------------ */
/* 본문 중간에 넣는 콘텐츠 카드                                          */
/* ------------------------------------------------------------------ */

/**
 * 사진 대신 쓰는 "본문 강조 카드".
 * 글의 특정 지점(1/5, 중간, 4/5)에 넣어 시선을 끊어주는 역할을 한다.
 * 실제 사진·일러스트는 생성하지 않고(추가 비용 0원), 그 지점의 핵심 내용을
 * 카드 형태로 시각화한다.
 */
function contentCard({ label, headline, points, accent, width, height }) {
  const chipList = (points || []).slice(0, 3).map((point) => (
    `<div style="display:flex; align-items:flex-start; gap:${height * 0.03}px; margin-top:${height * 0.045}px;">
       <div style="width:${height * 0.05}px; height:${height * 0.05}px; flex:none; border-radius:50%;
                   background:${accent}; color:#fff; font-weight:800; font-size:${height * 0.032}px;
                   display:flex; align-items:center; justify-content:center;">✓</div>
       <div style="flex:1; min-width:0; font-size:${height * 0.05}px; line-height:1.45; color:#20242a;
                   font-weight:600; word-break:keep-all; overflow:hidden; display:-webkit-box;
                   -webkit-line-clamp:2; -webkit-box-orient:vertical;">${escapeHtml(point)}</div>
     </div>`
  )).join('');

  return shell(width, height, `
  <div class="card" style="background:#fbfbfa; flex-direction:column; justify-content:center;
       padding:${height * 0.1}px ${height * 0.11}px;">
    <div style="position:absolute; left:0; top:0; bottom:0; width:${height * 0.045}px; background:${accent};"></div>
    <div style="position:absolute; right:${-height * 0.16}px; top:${-height * 0.2}px;
                width:${height * 0.5}px; height:${height * 0.5}px; border-radius:50%;
                background:${shade(accent, 210)}; opacity:.5;"></div>
    <div style="position:relative;">
      ${label ? `<div class="badge" style="background:${accent}; color:#fff; margin-bottom:${height * 0.06}px;">${escapeHtml(label)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.098}px; line-height:1.3; color:#14171a;">
        ${escapeHtml(headline)}
      </div>
      ${chipList}
    </div>
  </div>`);
}

export function renderContentCard(spec) {
  return contentCard(spec);
}
