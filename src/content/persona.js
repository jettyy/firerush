/**
 * 글을 쓰는 "사람"을 정의하는 모듈.
 *
 * 이 프로그램이 만드는 글은 백과사전이 아니라 블로그 글이다.
 * 네이버가 높게 치는 것은 정확한 정보 그 자체가 아니라
 * "이 사람이 직접 겪고 쓴 글" 이라는 신호다. 그래서 화자를 먼저 못 박아두고,
 * 그 화자가 절대 하지 않을 말을 금지 목록으로 따로 관리한다.
 *
 * quality.js 가 여기 정의된 패턴을 그대로 검사에 쓴다.
 * 지시문과 검사 기준을 한곳에 두어야 둘이 어긋나지 않는다.
 */

/* ------------------------------------------------------------------ */
/* 말투                                                                */
/* ------------------------------------------------------------------ */

// 한국어 문장이 제대로 끝났는지 보는 패턴들.
// 받침 형태를 따지지 않고 종결부만 본다. ("바랍니다", "만듭니다" 도 정상 처리)
const FORMAL_END = /(니다|니까|십시오)\s*[.!?…"'」』)\]]*$/;
const CASUAL_END = /(요|에요|예요)\s*[.!?…"'」』)\]]*$/;
const ANY_END = /(니다|니까|십시오|요|죠|지요)\s*[.!?…"'」』)\]]*$/;

/** 독백체의 표식. 이게 너무 적으면 말투만 바꾼 척한 딱딱한 글이다. */
const MONOLOGUE_MARK = /(네요|더라고요|더라구요|더군요|거든요|잖아요|같아요|같네요|같습니다|싶네요|겠네요|죠|지요|군요)\s*[.!?…"'」』)\]]*$/;

export const VOICES = {
  monologue: {
    label: '독백체',
    ending: ANY_END,
    endingLabel: '"~했네요 / ~더라고요 / ~인 것 같습니다"',
    markerRatio: 0.12,
    prompt: '친한 지인에게 내 경험을 들려주듯, 혼잣말에 가까운 덤덤한 구어체로 쓸 것. '
      + '"~했네요", "~더라고요", "~인 것 같습니다", "~라는 생각이 듭니다" 같은 어미를 섞고, '
      + '가르치려 드는 "~해야 합니다", "~하시기 바랍니다" 같은 훈계조는 쓰지 마세요.',
  },
  formal: {
    label: '존댓말(~습니다체)',
    ending: FORMAL_END,
    endingLabel: '"~습니다 / ~입니다"',
    markerRatio: 0,
    prompt: '모든 문장을 "~습니다", "~입니다" 형태의 정중한 종결어미로 끝낼 것.',
  },
  casual: {
    label: '해요체',
    ending: CASUAL_END,
    endingLabel: '"~해요 / ~예요"',
    markerRatio: 0,
    prompt: '모든 문장을 "~해요", "~예요" 형태로 부드럽게 끝낼 것.',
  },
};

export function getVoice(settings) {
  return VOICES[settings?.post?.voice] || VOICES.monologue;
}

export function hasMonologueMark(sentence) {
  return MONOLOGUE_MARK.test(sentence);
}

/* ------------------------------------------------------------------ */
/* 금지 표현                                                            */
/* ------------------------------------------------------------------ */

/**
 * 이 화자가 절대 쓰지 않는 표현들.
 * label 은 프롬프트에 그대로 들어가고, test 는 검사에 그대로 쓰인다.
 * fix 는 검사에 걸렸을 때 어떻게 고치라고 알려줄 문장이다.
 */
export const BANNED_PHRASES = [
  {
    id: 'drink',
    label: '음주 이야기',
    test: /(맥주|소주|막걸리|하이볼|술자리|술 한|한잔하|음주)/,
    fix: '술 이야기를 전부 빼세요. 퇴근 후 마시는 것은 얼음 넣은 탄산수나 커피로 바꿉니다.',
  },
  {
    id: 'photoSlot',
    label: '사진 자리 표시',
    test: /(\[\s*(사진|이미지|그림)|(사진|이미지)\s*(넣을|넣는|삽입할?|들어갈)\s*(자리|위치|곳|부분)|\(\s*사진\s*삽입\s*\))/,
    fix: '"[사진 넣을 자리]" 같은 표시를 모두 지우세요. 사진은 프로그램이 알아서 넣습니다.',
  },
  {
    id: 'secretBuy',
    label: '몰래 샀다는 이야기',
    test: /((와이프|아내|남편|마누라|배우자)\s*(몰래|모르게)|몰래\s*(샀|산|질렀|지름|구매|주문))/,
    fix: '배우자 몰래 샀다는 식의 설정을 빼세요. 필요해서 고민 끝에 산 것으로 씁니다.',
  },
  {
    id: 'smallHouse',
    label: '집이 좁다는 표현',
    test: /(집이\s*(좁|작)|좁아\s*터|좁은\s*집|협소한\s*집)/,
    fix: '집이 좁다는 표현을 빼세요. 평범하고 아늑한 집으로 묘사합니다.',
  },
  {
    id: 'realName',
    label: '가족 실명',
    test: /(은호|은효)/,
    fix: '아이들 이름을 쓰지 말고 "쌍둥이들", "둥이들", "우리 애들" 로만 부르세요.',
  },
  {
    id: 'cliche',
    label: '상투적 마무리',
    test: /(이상으로[^.]{0,30}(알아보았|살펴보았|정리해\s*보았)|도움이\s*되셨(길|기를|으면)|많은\s*도움이\s*되|파이팅|화이팅|다음\s*시간에\s*(만나|찾아))/,
    fix: '"이상으로 알아보았습니다", "도움이 되셨길 바랍니다" 같은 마무리를 지우고, '
      + '내일 할 일이나 개인적인 다짐으로 덤덤하게 끝내세요.',
  },
];

/** 번역투 접속사. 문장 앞에 기계적으로 붙는 것만 잡는다. */
export const ROBOT_CONNECTORS = [
  '결론적으로', '무엇보다도', '요컨대', '더욱이', '아울러', '이와 같이', '이처럼', '게다가',
];

// "한편" 은 "한 편의 글" 과 겹치지 않게 따로 본다.
const HANPYEON_RE = /(^|[\s,.])한편[,\s]/;

export function findConnectors(text) {
  const found = new Set();
  for (const word of ROBOT_CONNECTORS) {
    if (new RegExp(`(^|[\\s,.]|<b>)${word}([\\s,]|</b>)`).test(text)) found.add(word);
  }
  if (HANPYEON_RE.test(text)) found.add('한편');
  return [...found];
}

/* ------------------------------------------------------------------ */
/* 페르소나 프롬프트                                                     */
/* ------------------------------------------------------------------ */

/** 생활 맥락이 글에 녹아 있는지 볼 때 찾는 말들. */
export const LIFE_WORDS = /(쌍둥이|둥이|아이들|애들|아들램|딸램|퇴근|출근|육아|재우|주말|저녁에|퇴근길|회사)/g;

/** 화자 설정 블록. 프롬프트 맨 앞쪽에 놓는다. */
export function buildPersonaBlock(settings) {
  const persona = settings.persona || {};
  if (!persona.enabled) return '';

  const lines = ['[화자 — 이 글을 쓰는 사람]'];
  if (persona.nickname) lines.push(`- 블로그 닉네임: ${persona.nickname}`);
  if (persona.identity) lines.push(`- 정체성: ${persona.identity}`);
  if (persona.life) lines.push(`- 생활: ${persona.life}`);
  lines.push(
    '- 글 곳곳에 이 사람의 일상이 배경으로 깔려야 합니다. 주제가 무엇이든 '
    + '"애들 재우고 앉아서 찾아봤다", "출퇴근하면서 써 봤다" 처럼 내 생활과 연결해서 쓰세요.',
    '- 다만 육아 이야기가 주제를 잡아먹으면 안 됩니다. 배경으로만 스치듯 깔아주세요.',
  );
  if (persona.banned) lines.push(`- 절대 쓰지 않는 소재: ${persona.banned}`);
  return lines.join('\n');
}

/** 말투 블록. */
export function buildVoiceBlock(settings) {
  const voice = getVoice(settings);
  const lines = [
    '[말투]',
    `- ${voice.prompt}`,
    `- 어조: ${settings.post.tone}`,
  ];
  if (voice.markerRatio > 0) {
    lines.push(
      '- 처음부터 끝까지 칭찬만 늘어놓지 마세요. "처음엔 별거 아니라고 생각했는데", '
      + '"기대가 컸는지 이 부분은 좀 아쉬웠습니다" 처럼 솔직한 아쉬움과 반전을 섞어야 사람이 쓴 글로 읽힙니다.',
    );
  }
  lines.push(
    `- 번역투 접속사(${ROBOT_CONNECTORS.slice(0, 5).join(', ')}, 한편)를 쓰지 마세요. `
    + '문장을 짧게 끊고 다음 문장으로 바로 넘어갑니다.',
    '- "1. 개요 / 2. 특징 / 3. 장단점" 같은 딱딱한 번호 목차를 만들지 마세요. '
    + '소제목은 실제로 그 대목에서 하는 이야기를 그대로 적은 말이어야 합니다.',
  );
  return lines.join('\n');
}

/** 금지 표현 블록. */
export function buildBannedBlock(settings) {
  if (!settings.persona?.enabled) return '';
  return [
    '[절대 금지]',
    ...BANNED_PHRASES.map((phrase, index) => `${index + 1}. ${phrase.label} — ${phrase.fix}`),
  ].join('\n');
}
