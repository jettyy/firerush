import fs from 'node:fs';
import { SETTINGS_FILE, ensureDirs } from './paths.js';

export const DEFAULT_SETTINGS = {
  // 네이버
  blogId: '',                    // 비워두면 로그인한 계정에서 자동으로 알아낸다.

  // AI (claude CLI, 구독 요금제)
  claude: {
    command: 'claude',
    model: '',                   // 비우면 CLI 기본 모델
    /**
     * 표의 행만 채울 때 쓸 모델. 비우면 위의 model 을 그대로 쓴다.
     *
     * 표 행 채우기는 이름을 나열하는 일이라 판단력이 거의 필요 없다.
     * 실제로 Haiku·Sonnet·Opus 가 똑같이 50행을 빈칸 없이 채웠다.
     * 그런데 TOP100 글은 호출 대부분이 표 행 채우기라서,
     * 여기만 싼 모델로 내려도 구독 사용량이 눈에 띄게 줄어든다.
     * 본문은 위의 model 을 그대로 쓰므로 글 품질은 떨어지지 않는다.
     */
    tableModel: 'claude-sonnet-5',
    timeoutMs: 300000,
    // 본문을 쓸 때 웹 검색을 허용할지. 켜면 실제 수치와 출처를 인용할 수 있지만
    // 글 하나에 1~3분이 더 걸리고 구독 사용량을 더 쓴다.
    webSearch: true,
    searchTimeoutMs: 600000,
  },

  // 글을 쓰는 '사람'. 여기 적은 내용이 프롬프트 맨 앞에 들어가고,
  // 금지 소재는 품질 검사에서도 그대로 걸러진다. (src/content/persona.js)
  persona: {
    enabled: true,
    nickname: '두배파파',
    identity: '30대 후반 직장인이자 남매 쌍둥이를 키우는 아빠',
    life: '평일에는 출퇴근에 치이고, 퇴근하고 아이들을 재운 뒤에야 겨우 앉아서 글을 씁니다. '
      + '혼자 쉴 때는 얼음 가득 넣은 탄산수에 에스프레소 샷을 넣어 마십니다.',
    banned: '술·맥주·소주 같은 음주 이야기, 가족의 실명, 배우자 몰래 샀다는 이야기, 집이 좁다는 이야기',
  },

  // 글 설정
  post: {
    // voice 를 바꾸면 품질 검사의 종결어미 기준도 같이 바뀐다. (monologue | formal | casual)
    voice: 'monologue',
    tone: '퇴근하고 혼잣말하듯 덤덤하게, 친한 지인에게 경험을 들려주는 말투',
    minChars: 1800,              // 공백 제외 최소 글자 수 (품질 검사 기준)
    sectionCount: 4,             // 소제목 개수 (권장 3~4개)
    audience: '나와 비슷한 상황에서 이 주제를 검색해 본 사람',
    extraGuideline: '',
    addCriteria: true,           // 순위·비교 글 서두에 '고른 기준' 밝히기
    // 개수를 안 밝힌 "OO 순위" 글에서 표를 몇 개까지 채워볼지.
    // 자료가 모자라면 채워진 만큼만 남으므로 넉넉히 잡아도 손해가 아니다.
    // 다만 25개씩 나눠 받으므로 개수가 늘면 호출과 시간이 그만큼 늘어난다.
    rankCount: 100,
  },

  // 글 품질 검사 — 규칙을 어기면 그 항목만 짚어 자동으로 다시 쓰게 한다.
  quality: {
    enforce: true,
    maxRepairs: 1,               // 보정 재요청 횟수 (호출이 늘어나므로 1회 권장)
    blockOnFail: false,          // 끝내 못 고치면 저장하지 않고 실패로 둘지
  },

  // 상단 썸네일의 "배경 그림"만 이미지 생성 API로 받아온다.
  // 한글 문구는 HTML 템플릿이 그 위에 얹는다 — 이미지 모델이 한글을 깨뜨리기 때문이다.
  // 본문 강조 카드 3장은 여기를 쓰지 않는다. 돈이 드는 건 글 한 편당 딱 한 장.
  image: {
    enabled: false,              // API 키를 넣고 켜야 동작한다. 꺼져 있으면 지금까지와 똑같다.
    provider: 'google',
    // 비워두면 계정에서 쓸 수 있는 이미지 모델 목록을 받아 가장 싼 것을 자동으로 고른다.
    // 구글이 Imagen 4 계열을 2026-08-17 에 통째로 종료한 전례가 있어서,
    // 이름을 붙박이로 두지 않는다. 특정 모델을 고집하고 싶을 때만 여기에 적는다.
    model: '',
    apiKey: '',                  // 이 파일은 .gitignore 대상이라 저장소에 올라가지 않는다.
    timeoutMs: 60000,
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
