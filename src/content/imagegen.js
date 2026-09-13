/**
 * 썸네일 배경 그림을 이미지 생성 API로 받아오는 모듈.
 *
 * 글자는 절대 AI에게 맡기지 않는다. 이미지 모델은 한글을 자주 뭉개는데,
 * 100장을 뽑아놓고 글자가 깨져 있으면 전부 버려야 하기 때문이다.
 * 그래서 여기서는 "글자 없는 배경 그림"만 받고,
 * 한글 문구는 기존 HTML 템플릿이 그 위에 얹는다. (templates/index.js)
 *
 * 본문 강조 카드 3장은 여기를 거치지 않는다. 지금처럼 HTML 캡처 그대로다.
 * 돈이 드는 건 글 한 편당 상단 썸네일 한 장뿐이다.
 */

import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 이미지 모델에게 줄 지시문.
 *
 * 영어로 쓴다. 이미지 모델은 영어 지시를 훨씬 정확히 따르고,
 * 한국어를 넣으면 그 글자를 그림 안에 그려 넣으려는 경향이 있다.
 */
function buildPrompt(post) {
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
 * 구글은 이미지 모델 계열마다 호출 형식이 다르고, 한 번 갈아엎은 전례도 있다.
 * (Imagen 4 계열은 2026년 8월 17일에 종료되고 Gemini 이미지 모델로 넘어갔다)
 * 그래서 모델 이름을 설정으로 빼두고, 두 형식을 모두 지원한다.
 * 나중에 또 바뀌어도 설정에서 모델 이름만 바꾸면 된다.
 */
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
    ? ' — 이 모델이 없어졌거나 이름이 바뀐 것 같습니다. 설정의 "이미지 모델"을 '
      + '현재 쓸 수 있는 이름으로 바꿔주세요. (구글 AI Studio 의 모델 목록에서 확인)'
    : '';
  return `${status} ${detail}${hint}`;
}

/**
 * 배경 그림 한 장을 받아온다.
 * 실패하면 예외를 던지지 않고 null 을 돌려준다 — 썸네일은 기존 방식으로 계속 만들어야 한다.
 *
 * @returns {Promise<string|null>} data URI (png) 또는 null
 */
export async function generateBackground(post, { jobId = '', signal } = {}) {
  const settings = getSettings();
  const image = settings.image || {};

  if (!image.enabled) return null;
  if (!image.apiKey) {
    logger.warn('이미지 생성이 켜져 있지만 API 키가 비어 있습니다. 기존 썸네일로 만듭니다.', { jobId });
    return null;
  }

  const model = image.model || 'gemini-3.1-flash-image';
  const { url, body } = buildRequest(model, buildPrompt(post));

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
      logger.warn(
        `썸네일 배경 생성 실패 (${errorReason(response.status, await response.text())}). `
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

    logger.info(`썸네일 배경 그림을 받았습니다 (${model}).`, { jobId });
    return `data:image/png;base64,${base64}`;
  } catch (error) {
    const reason = error.name === 'AbortError' ? '시간 초과' : error.message;
    logger.warn(`썸네일 배경 생성 실패 (${reason}). 기존 방식으로 만듭니다.`, { jobId });
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

  const model = image.model || 'gemini-3.1-flash-image';
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
      message: `성공 — ${model} 로 그림을 받았습니다 (${Math.round(base64.length * 0.75 / 1024)}KB).`,
      preview: `data:image/png;base64,${base64}`,
    };
  } catch (error) {
    return { ok: false, message: `연결 실패: ${error.message}` };
  }
}
