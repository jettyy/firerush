import path from 'node:path';
import fs from 'node:fs';
import { renderTemplate, renderContentCard } from './templates/index.js';
import { buildHighlightCards } from './highlights.js';
import { generateThumbnailImage } from './imagegen.js';
import { getRenderBrowser } from '../lib/playwright.js';
import { getSettings } from '../lib/settings.js';
import { THUMB_DIR, ensureDirs } from '../lib/paths.js';
import { slugify } from '../lib/util.js';
import { logger } from '../lib/events.js';

/** HTML 문자열을 스크린샷 찍어 PNG 파일로 저장한다. 이미지 생성 API 없이, 추가 비용 0원. */
async function renderHtmlToPng(html, { width, height, filePath }) {
  const browser = await getRenderBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,          // 네이버 업로드 시 흐려지지 않게 2배로 뽑는다.
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // 웹폰트를 기다리되, 네트워크가 막혀 있으면 로컬 폰트로 그냥 진행한다.
    await page
      .evaluate(() => Promise.race([
        document.fonts?.ready,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]))
      .catch(() => {});
    // 배경 그림이 다 그려지기 전에 찍으면 그림이 빠진 채로 저장된다.
    await page
      .evaluate(() => Promise.race([
        Promise.all([...document.images].map((img) => (
          img.complete ? null : new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          })
        ))),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]))
      .catch(() => {});
    await page.waitForTimeout(250);
    await page.screenshot({ path: filePath, type: 'png' });
    return fs.statSync(filePath).size;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 상단 썸네일 한 장을 만든다.
 *
 * 이미지 생성이 켜져 있으면 AI가 그린 것을 쓰고(글자까지 그렸으면 그대로 저장),
 * 꺼져 있거나 실패하면 HTML 템플릿을 스크린샷 찍는 기존 방식으로 넘어간다.
 */
export async function renderThumbnail(post, { jobId = '', signal } = {}) {
  ensureDirs();
  const settings = getSettings();
  const { width, height } = settings.thumbnail;

  // 이미지 API 를 먼저 시도한다. 실패하면 null 이 와서 기존 HTML 방식으로 넘어간다.
  const generated = await generateThumbnailImage(post, { jobId, signal });

  const fileName = `${Date.now()}-${jobId || slugify(post.title, 24)}.png`;
  const filePath = path.join(THUMB_DIR, fileName);

  // 글자까지 그려서 받았으면 손대지 않고 그대로 쓴다.
  // 다시 그리면 그림이 눌리거나 화질만 깎인다.
  if (generated?.mode === 'full') {
    fs.writeFileSync(filePath, Buffer.from(generated.base64, 'base64'));
    const size = fs.statSync(filePath).size;
    logger.info(`썸네일 생성 완료 (AI가 통째로 그림, ${Math.round(size / 1024)}KB)`, { jobId });
    return { filePath, fileName, style: 'ai' };
  }

  const spec = { ...post.thumbnail, width, height, background: generated?.dataUri || null };
  const html = renderTemplate(spec);
  const size = await renderHtmlToPng(html, { width, height, filePath });

  const how = spec.background ? '배경 그림 + 한글 얹기' : spec.style;
  logger.info(`썸네일 생성 완료 (${how}, ${Math.round(size / 1024)}KB)`, { jobId });
  return { filePath, fileName, style: spec.background ? 'illust' : spec.style };
}

/**
 * 본문 중간에 넣을 강조 카드 이미지 3장을 만든다. (1/5, 중간, 4/5 지점용)
 * 글 구조에서 뽑아낸 문구를 카드로 그리는 것뿐이라 AI 호출이 늘지 않는다.
 * 후보가 부족한 글은 3장보다 적게 나올 수 있다 — 그 지점은 이미지 없이 넘어간다.
 *
 * @returns {Array<{filePath: string, fileName: string} | null>} 길이 3, 빈 자리는 null.
 */
export async function renderContentImages(post, { jobId = '' } = {}) {
  const settings = getSettings();
  const accent = post.thumbnail?.accent || '#16324F';
  // 세로로 긴 썸네일과 달리 본문 카드는 가로로 넓게, 본문 폭에 맞춘다.
  const width = 1200;
  const height = 640;

  const cards = buildHighlightCards(post);
  const results = [];

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (!card) {
      results.push(null);
      continue;
    }
    try {
      const html = renderContentCard({
        label: card.label,
        headline: card.headline,
        points: card.points,
        accent,
        width,
        height,
      });
      const fileName = `${Date.now()}-${jobId || 'card'}-${index + 1}.png`;
      const filePath = path.join(THUMB_DIR, fileName);
      const size = await renderHtmlToPng(html, { width, height, filePath });
      logger.info(`본문 카드 ${index + 1}/3 생성 완료 (${Math.round(size / 1024)}KB)`, { jobId });
      results.push({ filePath, fileName });
    } catch (error) {
      logger.warn(`본문 카드 ${index + 1}/3 생성 실패, 이 지점은 건너뜁니다: ${error.message}`, { jobId });
      results.push(null);
    }
  }

  void settings; // 카드 크기는 고정폭을 쓴다 (썸네일 설정과 별개).
  return results;
}

/** 대시보드 미리보기용 — 저장하지 않고 HTML만 돌려준다. */
export function previewThumbnailHtml(spec) {
  const settings = getSettings();
  return renderTemplate({
    headline: spec.headline || '썸네일 미리보기',
    subline: spec.subline || '주제에 맞춰 AI가 문구를 만듭니다',
    badge: spec.badge || '미리보기',
    emoji: spec.emoji || '✨',
    accent: /^#[0-9a-f]{6}$/i.test(spec.accent || '') ? spec.accent : '#16324F',
    style: spec.style && spec.style !== 'auto' ? spec.style : 'bold',
    width: settings.thumbnail.width,
    height: settings.thumbnail.height,
  });
}
