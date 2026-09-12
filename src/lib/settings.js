import fs from 'node:fs';
import { SETTINGS_FILE, ensureDirs } from './paths.js';

export const DEFAULT_SETTINGS = {
  // 네이버
  blogId: '',                    // 비워두면 로그인한 계정에서 자동으로 알아낸다.

  // AI (claude CLI, 구독 요금제)
  claude: {
    command: 'claude',
    model: '',                   // 비우면 CLI 기본 모델
    timeoutMs: 300000,
  },

  // 글 설정
  post: {
    // 품질 검사(formalEnding)가 종결어미를 검사하므로, 바꾸면 검사 기준도 같이 바뀐다.
    tone: '정중한 존댓말 (~습니다 / ~입니다)',
    formalEnding: true,          // true: ~습니다체 검사 / false: ~해요체 검사
    minChars: 1800,              // 공백 제외 최소 글자 수 (품질 검사 기준)
    sectionCount: 4,             // 소제목 개수 (권장 3~4개)
    audience: '해당 주제의 정보를 처음 찾아보는 일반 독자',
    extraGuideline: '',
    addCriteria: true,           // 서두에 '선정 기준' 밝히기
  },

  // 글 품질 검사 — 규칙을 어기면 그 항목만 짚어 자동으로 다시 쓰게 한다.
  quality: {
    enforce: true,
    maxRepairs: 1,               // 보정 재요청 횟수 (호출이 늘어나므로 1회 권장)
    blockOnFail: false,          // 끝내 못 고치면 저장하지 않고 실패로 둘지
  },

  // 썸네일 (글 최상단) + 본문 강조 카드 (1/5·중간·4/5 지점)
  thumbnail: {
    width: 1200,
    height: 630,
    style: 'auto',               // auto | bold | gradient | minimal | editorial
    contentCards: true,          // 본문 중간에 강조 카드 이미지 3장을 넣을지
  },

  // 실행
  run: {
    delayMinSec: 30,
    delayMaxSec: 90,
    maxRetries: 1,
    headless: false,             // 네이버는 실제 창을 띄우는 편이 안전하다.
    slowMoMs: 20,
    screenshotOnError: true,
    chromiumPath: '',            // 비우면 Playwright가 받아온 크로미움을 쓴다.
  },
};

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  if (typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

let cache = null;

export function getSettings() {
  if (cache) return cache;
  ensureDirs();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  cache = deepMerge(DEFAULT_SETTINGS, stored);
  return cache;
}

export function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  ensureDirs();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}
