/**
 * 상단 썸네일을 이미지 생성 API로 받아오는 모듈. 두 가지 방식이 있다.
 *
 *   full       한글 문구까지 그림 안에 그려 완성된 썸네일을 통째로 받는다. (기본)
 *              광고 배너처럼 화려하게 나오지만, 모델이 한글을 뭉갤 위험이 있다.
 *   background 글자 없는 배경만 받고 한글은 HTML 템플릿이 얹는다.
 *              한글이 절대 안 깨지는 대신 덜 화려하다.
 *
 * 한글이 깨져 나오면 설정에서 background 로 내리거나, 모델 우선순위를
 * "품질 우선"으로 바꾸면 된다. pro 등급이 글자를 훨씬 정확하게 그린다.
 *
 * 본문 강조 카드 3장은 여기를 거치지 않는다. 지금처럼 HTML 캡처 그대로다.
 * 돈이 드는 건 글 한 편당 상단 썸네일 한 장뿐이다.
 */

import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 그림 안에 글자를 넣지 않는 지시문. (배경만 받아 HTML 로 한글을 얹는 방식)
 *
 * 영어로 쓴다. 이미지 모델은 영어 지시를 훨씬 정확히 따르고,
 * 한국어를 넣으면 그 글자를 그림 안에 그려 넣으려는 경향이 있다.
 */
function buildBackgroundPrompt(post) {
  const scene = String(post.thumbnail?.scene || '').trim();
  const subject = scene || `the topic: ${post.topic || post.title}`;

  return [
    `Flat vector illustration for a Korean blog cover image about ${subject}.`,
    'Modern clean editorial style, bright saturated colors, bold simple shapes,',
    'soft gradient background, subtle depth, friendly and approachable mood.',
    // 글자를 막는 것이 이 지시문의 핵심이다. 여러 표현으로 반복해서 막는다.
    'ABSOLUTELY NO TEXT of any kind: no letters, no words, no numbers, no captions,',
    'no labels, no signage, no typography, no watermark, no logo, no UI elements.',
    'Pure illustration only.',
    // 아래쪽에 한글 문구가 얹히므로 그 자리를 비워둬야 한다.
    'Compose the artwork so the bottom third is visually calm and uncluttered,',
    'leaving open space there for a caption to be added later.',
    'Wide 16:9 composition.',
  ].join(' ');
}

/**
 * 한글 문구까지 그림 안에 그려 넣는 지시문. (완성된 썸네일을 통째로 받는 방식)
 *
 * 넣을 글자를 따옴표로 묶어 "글자 그대로" 그리라고 못 박는다.
 * 이렇게 해야 모델이 문구를 제멋대로 바꾸거나 영어로 옮기지 않는다.
 */
function buildPosterPrompt(post) {
  const thumb = post.thumbnail || {};
  const scene = String(thumb.scene || '').trim();
  const headline = String(thumb.headline || post.title || '').trim();
  const subline = String(thumb.subline || '').trim();
  const badge = String(thumb.badge || '').trim();

  const lines = [
    'A bold, eye-catching Korean blog thumbnail poster. Wide 16:9.',
    '',
    'Render the following KOREAN text inside the image, spelled EXACTLY',
    'character for character, with no changes, no translation, no extra words:',
    `  MAIN HEADLINE (largest, most prominent): "${headline}"`,
  ];
  if (subline) lines.push(`  SUB HEADLINE (on a ribbon banner below the headline): "${subline}"`);
  if (badge) lines.push(`  SMALL CORNER BADGE: "${badge}"`);

  lines.push(
    '',
    'Typography: thick chunky 3D Korean lettering with heavy black outline and drop shadow,',
    'bright yellow and white fill, slight upward tilt, very high contrast so it stays',
    'readable on a small phone screen. Korean (Hangul) characters must be well-formed and legible.',
    '',
    `Artwork around the text: ${scene || `illustrations representing ${post.topic || post.title}`}.`,
    'Vivid saturated colors, cheerful illustrated Korean people, small circular topic icons',
    'along one edge, dynamic diagonal panel composition, subtle badges and accents.',
    'Korean promotional banner style, like a popular blog cover.',
    '',
    'Do NOT add any words beyond the Korean text listed above.',
    'No English text, no watermark, no logo, no gibberish letterforms.',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 쓸 모델 고르기                                                       */
/* ------------------------------------------------------------------ */

/**
 * 구글이 이미지 모델을 통째로 갈아엎은 적이 있다.
 * (Imagen 4 계열은 2026년 8월 17일 종료, 호출 형식까지 바뀌었다)
 *
 * 그래서 모델 이름을 사람이 관리하지 않는다. 계정에서 실제로 쓸 수 있는
 * 목록을 받아와 그중 가장 싼 것을 자동으로 고른다. 이름이 또 바뀌어도
 * 프로그램을 고칠 필요가 없다.
 */
const MODEL_LIST_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 목록을 못 받아왔을 때 마지막으로 기대볼 이름. */
const FALLBACK_MODEL = 'gemini-3.1-flash-image';

/** 이미 종료된 모델. 설정에 남아 있어도 무시하고 다시 고른다. */
const RETIRED = /^imagen-4\.0-/i;

/** 계정에서 고른 모델을 프로세스가 사는 동안 재사용한다. 글마다 목록을 받을 이유가 없다. */
let resolved = { key: '', model: '' };

/**
 * 이미지 "생성" 모델인지 보고, 싼 순서를 매긴다.
 * 점수가 낮을수록 먼저 고른다. 후보가 아니면 null.
 */
function rankModel(id, prefer) {
  if (!/image/i.test(id)) return null;        // 이미지 생성 모델이 아니다
  if (/ultra/i.test(id)) return null;         // 가장 비싼 등급은 쓰지 않는다

  // flash 가 싸고, pro 가 글자를 정확하게 그린다.
  // 한글을 그림 안에 넣을 때는 pro 쪽이 덜 깨진다.
  const isFlash = /flash/i.test(id);
  const isPro = /pro/i.test(id);
  const cheapFirst = isFlash ? 0 : (isPro ? 2 : 1);
  const qualityFirst = isPro ? 0 : (isFlash ? 2 : 1);

  return {
    tier: prefer === 'quality' ? qualityFirst : cheapFirst,
    preview: /preview|exp\b/i.test(id) ? 1 : 0,
    // 같은 등급이면 최신 버전이 품질 대비 유리하다.
    version: Number.parseFloat((id.match(/(\d+(?:\.\d+)?)/) || [])[1] || '0'),
  };
}

/**
 * 계정에서 쓸 수 있는 이미지 모델 중 가장 싼 것을 고른다.
 *
 * 목록은 여러 장으로 나뉘어 온다. 첫 장만 보면 이미지 모델이 뒷장에 있을 때
 * "쓸 수 있는 모델이 없다" 고 잘못 판단하므로 끝까지 넘겨본다.
 */
async function pickBestModel(apiKey, prefer) {
  const candidates = [];
  let pageToken = '';

  for (let page = 0; page < 10; page += 1) {
    const url = new URL(MODEL_LIST_URL);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey } });
    if (!response.ok) {
      throw new Error(errorReason(response.status, await response.text()));
    }
    const data = await response.json();

    for (const entry of data?.models || []) {
      const id = String(entry?.name || '').replace(/^models\//, '');
      const methods = entry?.supportedGenerationMethods || [];
      // 이미지를 만들어 주는 호출을 지원해야 한다.
      if (!methods.includes('generateContent') && !methods.includes('predict')) continue;
      const rank = rankModel(id, prefer);
      if (rank) candidates.push({ id, ...rank });
    }

    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
  }

  if (!candidates.length) throw new Error('계정에서 쓸 수 있는 이미지 생성 모델을 찾지 못했습니다.');
  candidates.sort((a, b) => (
    a.tier - b.tier || a.preview - b.preview || b.version - a.version
  ));
  return candidates[0].id;
}

/**
 * 이번 호출에 쓸 모델 이름.
 * 설정에 직접 적어둔 이름이 있으면 그것을 쓰고(종료된 모델은 무시),
 * 없으면 계정 목록에서 자동으로 고른다.
 */
async function resolveModel(image, { jobId = '' } = {}) {
  const pinned = String(image.model || '').trim();
  if (pinned && !RETIRED.test(pinned)) return pinned;

  const prefer = image.prefer === 'quality' ? 'quality' : 'cheap';
  const cacheKey = `${image.apiKey}|${prefer}`;
  if (resolved.key === cacheKey && resolved.model) return resolved.model;

  try {
    const picked = await pickBestModel(image.apiKey, prefer);
    resolved = { key: cacheKey, model: picked };
    logger.info(`이미지 모델을 자동으로 골랐습니다: ${picked}`, { jobId });
    return picked;
  } catch (error) {
    logger.warn(
      `이미지 모델 목록을 받지 못해 ${FALLBACK_MODEL} 로 시도합니다. (${error.message})`,
      { jobId },
    );
    return FALLBACK_MODEL;
  }
}

/** Imagen 계열은 :predict, Gemini 계열은 :generateContent 로 형식이 다르다. */
function isImagen(model) {
  return /^imagen/i.test(model);
}

function buildRequest(model, prompt) {
  // 옛 Imagen 계열: :predict + instances/parameters
  if (isImagen(model)) {
    return {
      url: `${HOST}/${model}:predict`,
      body: {
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: '16:9' },
      },
    };
  }
  // 현행 Gemini 이미지 모델: :generateContent + contents/generationConfig
  return {
    url: `${HOST}/${model}:generateContent`,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // 이미지만 달라고 하면 거부당한다. 텍스트를 함께 받아야 한다.
        // (돌려받은 텍스트는 쓰지 않고 그림 조각만 꺼낸다)
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9' },
      },
    },
  };
}

/** 두 형식의 응답 어디에 base64 가 들어 있든 꺼내온다. */
function extractBase64(data) {
  const fromImagen = data?.predictions?.[0]?.bytesBase64Encoded;
  if (fromImagen) return fromImagen;

  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) return inline.data;
  }
  return '';
}

/**
 * 응답이 오류일 때 사람이 읽을 수 있는 이유를 뽑아낸다.
 *
 * 404 는 대개 "그 모델이 없어졌다" 는 뜻이다. 구글이 이미지 모델을 한 번
 * 통째로 갈아엎은 적이 있어서, 무엇을 해야 하는지까지 같이 알려준다.
 */
function errorReason(status, text) {
  let detail = String(text || '').slice(0, 200);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || parsed?.error?.status || detail;
  } catch {
    // JSON 이 아니면 앞부분을 그대로 쓴다.
  }
  const hint = status === 404
    ? ' — 고른 모델이 없어진 것 같습니다. 다음 글에서 목록을 다시 받아 새로 고릅니다.'
    : '';
  return `${status} ${detail}${hint}`;
}

/**
 * 배경 그림 한 장을 받아온다.
 * 실패하면 예외를 던지지 않고 null 을 돌려준다 — 썸네일은 기존 방식으로 계속 만들어야 한다.
 *
 * @returns {Promise<string|null>} data URI (png) 또는 null
 */
export async function generateThumbnailImage(post, { jobId = '', signal } = {}) {
  const settings = getSettings();
  const image = settings.image || {};
  const mode = image.mode === 'background' ? 'background' : 'full';

  // 왜 그림이 안 들어갔는지는 로그만 보고도 알 수 있어야 한다.
  // 조용히 넘어가면 설정을 켠 줄 알았던 사람이 원인을 찾을 방법이 없다.
  if (!image.enabled) {
    logger.info(
      '썸네일 이미지 생성은 건너뜁니다 — 설정에서 "썸네일을 이미지 생성 AI로 만들기"가 꺼져 있습니다.',
      { jobId },
    );
    return null;
  }
  if (!image.apiKey) {
    logger.warn('이미지 생성이 켜져 있지만 API 키가 비어 있습니다. 기존 썸네일로 만듭니다.', { jobId });
    return null;
  }

  const model = await resolveModel(image, { jobId });
  const prompt = mode === 'full' ? buildPosterPrompt(post) : buildBackgroundPrompt(post);
  const { url, body } = buildRequest(model, prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), image.timeoutMs || 60000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': image.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 고른 모델이 없어졌다면 캐시를 비워 다음 글에서 목록부터 다시 받게 한다.
      if (response.status === 404) resolved = { key: '', model: '' };
      logger.warn(
        `썸네일 이미지 생성 실패 (${errorReason(response.status, await response.text())}). `
        + '기존 방식으로 만듭니다.',
        { jobId },
      );
      return null;
    }

    const base64 = extractBase64(await response.json());
    if (!base64) {
      logger.warn('이미지 응답에 그림이 없습니다. 기존 방식으로 만듭니다.', { jobId });
      return null;
    }

    logger.info(
      mode === 'full'
        ? `썸네일을 통째로 받았습니다 (${model}). 한글 문구도 그림 안에 들어 있습니다.`
        : `썸네일 배경 그림을 받았습니다 (${model}). 한글은 프로그램이 얹습니다.`,
      { jobId },
    );
    return { mode, base64, dataUri: `data:image/png;base64,${base64}` };
  } catch (error) {
    const reason = error.name === 'AbortError' ? '시간 초과' : error.message;
    logger.warn(`썸네일 이미지 생성 실패 (${reason}). 기존 방식으로 만듭니다.`, { jobId });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 설정 화면의 "이미지 연결 테스트" 버튼용. 성공/실패 이유를 그대로 돌려준다. */
export async function testImageApi() {
  const settings = getSettings();
  const image = settings.image || {};
  if (!image.apiKey) return { ok: false, message: 'API 키를 먼저 입력하고 저장하세요.' };

  // 테스트할 때는 캐시를 비우고 목록부터 다시 받는다. 무엇이 고를지 눈으로 확인하는 버튼이다.
  resolved = { key: '', model: '' };
  const model = await resolveModel(image);
  const { url, body } = buildRequest(model, 'A simple flat vector illustration of a blue circle on a light background. No text.');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': image.apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, message: errorReason(response.status, await response.text()) };
    }
    const base64 = extractBase64(await response.json());
    if (!base64) return { ok: false, message: '응답은 왔지만 그림이 들어 있지 않습니다. 모델 이름을 확인하세요.' };
    return {
      ok: true,
      message: `성공 — 가장 저렴한 모델로 ${model} 을 골랐고, 그림을 받았습니다 `
        + `(${Math.round(base64.length * 0.75 / 1024)}KB).`,
      preview: `data:image/png;base64,${base64}`,
    };
  } catch (error) {
    return { ok: false, message: `연결 실패: ${error.message}` };
  }
}
