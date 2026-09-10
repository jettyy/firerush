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
    tone: '친근한 존댓말 (~해요체)',
    targetChars: 2000,
    sectionCount: 5,
    audience: '해당 주제를 처음 접하는 일반 독자',
    extraGuideline: '',
  },

  // 썸네일
  thumbnail: {
    width: 1200,
    height: 630,
    style: 'auto',               // auto | bold | gradient | minimal | editorial
  },

  // 실행
  run: {
    delayMinSec: 30,
    delayMaxSec: 90,
    maxRetries: 1,
    headless: false,             // 네이버는 실제 창을 띄우는 편이 안전하다.
    slowMoMs: 40,
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
