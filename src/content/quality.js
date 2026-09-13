/**
 * 블로그 글 품질 기준 모듈.
 *
 * 여기 한 곳에 "무엇을 지켜야 하는가" 를 적어 두고
 *   - 프롬프트에 넣을 지시문   (buildRuleBlock)
 *   - 결과물을 실제로 검사     (checkCompliance)
 * 두 가지를 같은 정의에서 만들어 낸다. 지시와 검사가 따로 놀면
 * "규칙은 넣었는데 안 지켜진 글" 이 그대로 저장되기 때문이다.
 *
 * 검사에서 걸린 항목은 generator 가 그 항목만 짚어 한 번 더 고쳐 쓰게 한다.
 *
 * 말투·페르소나·금지 표현은 persona.js 에 있다. 그쪽 정의를 그대로 가져다 검사한다.
 */

import {
  BANNED_PHRASES, LIFE_WORDS, findConnectors, getVoice, hasMonologueMark,
} from './persona.js';

/* ------------------------------------------------------------------ */
/* 본문에서 글자 뽑아내기                                                */
/* ------------------------------------------------------------------ */

/** 문단/목록처럼 '문장'으로 판단할 부분만 모은다. (제목·표는 제외) */
export function sentenceSources(post) {
  const out = [];
  const pushAll = (list) => (list || []).forEach((text) => out.push(String(text)));

  pushAll(post.intro);
  if (post.criteria) {
    pushAll(post.criteria.paragraphs);
    pushAll(post.criteria.items);
  }
  for (const section of post.sections || []) {
    pushAll(section.paragraphs);
    pushAll(section.list);
    if (section.quote) out.push(section.quote);
    for (const sub of section.subsections || []) {
      pushAll(sub.paragraphs);
      pushAll(sub.list);
    }
  }
  for (const item of post.faq || []) out.push(item.answer);
  pushAll(post.outro);
  return out.filter((text) => text.trim());
}

/** 표·제목까지 포함한 글 전체 텍스트. 분량과 기호 검사에 쓴다. */
export function allText(post) {
  const out = [...sentenceSources(post)];
  out.push(post.title || '');
  if (post.criteria?.heading) out.push(post.criteria.heading);
  for (const section of post.sections || []) {
    out.push(section.heading || '');
    for (const sub of section.subsections || []) out.push(sub.heading || '');
  }
  for (const item of post.faq || []) out.push(item.question || '');
  if (post.table) {
    out.push(post.table.heading || '', post.table.note || '');
    for (const row of post.table.rows || []) out.push(...row);
  }
  return out.join('\n');
}

/** "공백 제외 N자" 를 그대로 센다. */
export function countChars(post) {
  return allText(post)
    .replace(/<\/?(b|strong|em|i)>/gi, '')
    .replace(/\s+/gu, '')
    .length;
}

/** 문장 단위로 자른다. 한국어 종결어미 검사용. */
function splitSentences(texts) {
  const sentences = [];
  for (const text of texts) {
    for (const piece of String(text).split(/(?<=[.!?])\s+|\n+/)) {
      const trimmed = piece.replace(/<\/?(b|strong|em|i)>/gi, '').trim();
      if (trimmed.length >= 6) sentences.push(trimmed);
    }
  }
  return sentences;
}

/* ------------------------------------------------------------------ */
/* 금지 기호                                                            */
/* ------------------------------------------------------------------ */

// 정돈되지 않은 글로 보이게 만드는 장식 기호들.
// 물결표(~)는 "40~60%" 처럼 정상적으로 쓰이므로 넣지 않는다.
const BANNED_SYMBOLS = /[★☆◆◇■□▣▶▷◀◁●◎※♥♡♣♠✓✔✗✘✦✧✨➡⇒→←↑↓＊]/u;
const EMOJI = /\p{Extended_Pictographic}/u;

// 서론 맨 앞에 오면 안 되는 인사말·메타 안내 문장.
const GREETING = /^(안녕하세요|반갑습니다|여러분|오늘은|이번\s*(포스팅|글|시간)|금일|본\s*포스팅|이\s*글에서는|지난\s*시간에)/;
const META_SENTENCE = /(알아보(겠습니다|도록 하겠습니다)|살펴보(겠습니다|도록 하겠습니다)|정리해\s*보(겠습니다|았습니다)|준비했습니다)\s*[.!]?\s*$/;

// "~함 / ~임 / ~됨" 개조식(메모식). 어느 말투에서도 금지한다.
const MEMO_TAIL = /([가-힣]{2,12})(함|됨|임)\s*[.!]?$/;
// 문장 끝에 올 수 있는 평범한 명사들. 개조식으로 오해하지 않게 빼둔다.
const MEMO_EXCEPTIONS = new Set(['모임', '쓰임', '다짐', '조임', '놀림', '가짐']);

function looksMemoStyle(sentence, endingPattern) {
  if (endingPattern.test(sentence)) return false;
  const matched = sentence.match(MEMO_TAIL);
  if (!matched) return false;
  const word = `${matched[1].slice(-1)}${matched[2]}`;
  return !MEMO_EXCEPTIONS.has(word);
}

/* ------------------------------------------------------------------ */
/* 규칙 정의                                                            */
/* ------------------------------------------------------------------ */

/**
 * 각 규칙은 그대로 프롬프트 문장이 되고, 그대로 검사기가 된다.
 * check() 는 { ok, detail } 을 돌려준다. detail 은 보정 요청에 그대로 실린다.
 */
export const RULES = [
  {
    id: 'length',
    label: '분량',
    prompt: (s) => `공백을 제외하고 ${s.post.minChars.toLocaleString()}자 이상. `
      + '각 항목을 짧게 훑고 끝내지 말고, 근거와 사례를 붙여 충분히 길게 쓰세요.',
    check: (post, settings) => {
      const count = countChars(post);
      const need = settings.post.minChars;
      return {
        ok: count >= need,
        detail: `공백 제외 ${count.toLocaleString()}자 / 필요 ${need.toLocaleString()}자`
          + (count >= need ? '' : ` — ${(need - count).toLocaleString()}자가 부족합니다. `
            + '문단을 더 늘리거나 항목별 설명을 더 구체적으로 채우세요.'),
        value: count,
      };
    },
  },
  {
    id: 'ending',
    label: '종결어미',
    prompt: (s) => `모든 문장을 ${getVoice(s).endingLabel} 처럼 완전한 종결어미로 끝낼 것. `
      + '"~함", "~임", "~음" 같은 개조식·메모식 표현은 목록 항목에서도 절대 쓰지 마세요.',
    check: (post, settings) => {
      const voice = getVoice(settings);
      const sentences = splitSentences(sentenceSources(post));
      if (!sentences.length) return { ok: false, detail: '검사할 문장이 없습니다.' };

      const memo = sentences.filter((s) => looksMemoStyle(s, voice.ending));
      if (memo.length) {
        return {
          ok: false,
          detail: `개조식("~함/~임") 문장이 ${memo.length}개 있습니다: `
            + memo.slice(0, 3).map((s) => `"${s.slice(0, 40)}"`).join(', '),
        };
      }

      const closed = sentences.filter((s) => voice.ending.test(s));
      const ratio = closed.length / sentences.length;
      return {
        ok: ratio >= 0.85,
        detail: `${voice.endingLabel} 종결 ${Math.round(ratio * 100)}% (기준 85%)`
          + (ratio >= 0.85 ? '' : ` — 고쳐야 할 문장: ${sentences.filter((s) => !voice.ending.test(s))
            .slice(0, 3).map((s) => `"${s.slice(0, 40)}"`).join(', ')}`),
      };
    },
  },
  {
    id: 'voice',
    label: '사람 말투',
    prompt: () => '"~했네요", "~더라고요", "~인 것 같습니다" 같은 구어체 어미를 글 전체에 고르게 섞을 것. '
      + '보고서처럼 딱딱하게만 끝나면 AI가 쓴 글로 읽힙니다.',
    enabledWhen: (settings) => getVoice(settings).markerRatio > 0,
    check: (post, settings) => {
      const need = getVoice(settings).markerRatio;
      const sentences = splitSentences(sentenceSources(post));
      if (!sentences.length) return { ok: false, detail: '검사할 문장이 없습니다.' };
      const marked = sentences.filter(hasMonologueMark).length;
      const ratio = marked / sentences.length;
      return {
        ok: ratio >= need,
        detail: ratio >= need
          ? `구어체 어미 ${Math.round(ratio * 100)}%`
          : `구어체 어미가 ${Math.round(ratio * 100)}%뿐입니다 (기준 ${Math.round(need * 100)}%). `
            + '문장 끝을 "~네요", "~더라고요", "~거든요", "~인 것 같습니다" 로 바꿔 더 섞으세요.',
      };
    },
  },
  {
    id: 'banned',
    label: '금지 표현',
    prompt: (s) => (s.persona?.enabled
      ? `다음을 절대 쓰지 말 것: ${BANNED_PHRASES.map((p) => p.label).join(', ')}.`
      : '"[사진 넣을 자리]" 같은 이미지 위치 표시를 쓰지 말 것.'),
    check: (post, settings) => {
      const text = allText(post);
      const active = settings.persona?.enabled
        ? BANNED_PHRASES
        : BANNED_PHRASES.filter((phrase) => phrase.id === 'photoSlot' || phrase.id === 'cliche');
      // 주제 자체가 그 단어를 담고 있으면(예: "음주운전 벌금") 빼고 본다.
      // 사용자가 고른 주제까지 금지어로 막으면 영영 통과할 수 없는 글이 된다.
      const topic = String(post.topic || '');
      const hits = active.filter(
        (phrase) => phrase.test.test(text) && !phrase.test.test(topic),
      );
      return {
        ok: hits.length === 0,
        detail: hits.length === 0
          ? '금지 표현 없음'
          : hits.map((phrase) => `${phrase.label} — ${phrase.fix}`).join(' / '),
      };
    },
  },
  {
    id: 'connectors',
    label: '번역투 접속사',
    prompt: () => '"결론적으로", "무엇보다도", "한편", "게다가", "요컨대" 같은 기계적인 접속사를 쓰지 말 것. '
      + '문장을 짧게 끊고 다음 문장으로 바로 넘어가세요.',
    check: (post) => {
      const found = findConnectors(sentenceSources(post).join('\n'));
      return {
        ok: found.length === 0,
        detail: found.length === 0
          ? '번역투 접속사 없음'
          : `지워야 할 접속사: ${found.join(', ')} — 접속사를 빼고 문장을 바로 이으세요.`,
      };
    },
  },
  {
    id: 'paragraph',
    label: '문단 길이',
    prompt: () => '문단 하나는 2~3문장까지만. 스마트폰에서 읽기 때문에 한 덩어리가 길면 바로 이탈합니다. '
      + '문단을 짧게 끊어 여러 개로 나누세요.',
    check: (post) => {
      const paragraphs = [];
      const push = (list) => (list || []).forEach((text) => paragraphs.push(String(text)));
      push(post.intro);
      if (post.criteria) push(post.criteria.paragraphs);
      for (const section of post.sections || []) {
        push(section.paragraphs);
        for (const sub of section.subsections || []) push(sub.paragraphs);
      }
      push(post.outro);
      if (!paragraphs.length) return { ok: false, detail: '문단이 없습니다.' };

      const long = paragraphs.filter((text) => text.replace(/\s+/g, '').length > 240);
      return {
        ok: long.length === 0,
        detail: long.length === 0
          ? `문단 ${paragraphs.length}개 모두 적당한 길이`
          : `너무 긴 문단이 ${long.length}개 있습니다: `
            + long.slice(0, 2).map((text) => `"${text.slice(0, 30)}..."`).join(', ')
            + ' — 2~3문장씩 끊어 여러 문단으로 나누세요.',
      };
    },
  },
  {
    id: 'specifics',
    label: '구체적인 숫자',
    prompt: () => '"비쌌다", "오래 걸렸다" 같은 뭉뚱그린 표현 대신 가격·시간·개수·크기를 숫자로 적을 것. '
      + '일반 명사 대신 구체적인 제품명과 지명을 쓰세요.',
    check: (post) => {
      // 자릿수가 아니라 "숫자로 짚은 대목이 몇 군데냐" 를 센다.
      // "6개월" 과 "2만 5천 원" 은 자릿수는 다르지만 둘 다 구체적인 한 군데다.
      const spots = (sentenceSources(post).join(' ').match(/\d+/g) || []).length;
      return {
        ok: spots >= 5,
        detail: spots >= 5
          ? `숫자로 짚은 대목 ${spots}군데`
          : `숫자로 짚은 대목이 ${spots}군데뿐입니다 (5군데 이상 필요). `
            + '가격, 걸린 시간, 개수, 크기를 구체적인 숫자로 바꿔 적으세요.',
      };
    },
  },
  {
    id: 'honest',
    label: '솔직한 아쉬움',
    prompt: () => '장점만 나열하지 말고 아쉬운 점, 주의할 점, 내가 했던 실수를 최소 한 군데 솔직하게 적을 것. '
      + '이게 사람이 쓴 글이라는 가장 강한 증거입니다.',
    check: (post) => {
      const text = sentenceSources(post).join(' ');
      const found = text.match(/(아쉽|아쉬운|아쉬웠|단점|불편|실망|부담|걸리는 점|주의할|한계|막상|기대(가|보다))/g) || [];
      return {
        ok: found.length >= 1,
        detail: found.length >= 1
          ? '아쉬운 점을 솔직하게 짚었습니다'
          : '좋은 말만 있습니다. 아쉬웠던 점이나 주의할 점을 최소 한 문단 넣으세요.',
      };
    },
  },
  {
    id: 'life',
    label: '생활 맥락',
    prompt: () => '주제가 무엇이든 내 일상(퇴근, 육아, 주말)을 배경으로 자연스럽게 깔 것. '
      + '다만 일상 이야기가 주제를 잡아먹으면 안 됩니다.',
    enabledWhen: (settings) => Boolean(settings.persona?.enabled),
    check: (post) => {
      const found = sentenceSources(post).join(' ').match(LIFE_WORDS) || [];
      return {
        ok: found.length >= 2,
        detail: found.length >= 2
          ? '내 생활이 배경으로 깔려 있습니다'
          : '글에 쓰는 사람의 생활이 전혀 안 보입니다. 도입부와 중간에 '
            + '"애들 재우고 찾아봤다" 같은 내 상황을 한두 군데 넣으세요.',
      };
    },
  },
  {
    id: 'headings',
    label: '소제목 구조',
    prompt: (s) => `소제목 ${s.post.sectionCount}개(3~4개 권장)와 그 아래 세부 소제목을 적극 활용할 것.`,
    check: (post) => {
      const h2 = (post.sections || []).filter((s) => s.heading).length
        + (post.criteria?.heading ? 1 : 0)
        + (post.faq?.length ? 1 : 0);
      const h3 = (post.sections || []).reduce(
        (total, section) => total + (section.subsections || []).filter((sub) => sub.heading).length, 0,
      );
      const problems = [];
      if (h2 < 3) problems.push(`소제목이 ${h2}개뿐입니다 (3개 이상 필요)`);
      if (h3 < 1) problems.push('세부 소제목이 하나도 없습니다');
      return {
        ok: problems.length === 0,
        detail: problems.length ? problems.join(' / ') : `소제목 ${h2}개 · 세부 소제목 ${h3}개`,
      };
    },
  },
  {
    id: 'criteria',
    label: '선정 기준',
    prompt: () => '서두에 "순위·추천을 어떤 기준으로 골랐는지"를 밝히는 단락을 넣을 것. '
      + '기준을 고른 이유도 내 상황에 빗대어 설명하세요.',
    // 일상 정보성 글에까지 '선정 기준' 단락을 강요하면 오히려 딱딱해진다.
    enabledWhen: (settings, post) => settings.post.addCriteria && post?.shape !== 'general',
    check: (post) => {
      const items = post.criteria?.items || [];
      const body = (post.criteria?.paragraphs || []).join('');
      return {
        ok: items.length >= 2 && body.length >= 40,
        detail: items.length >= 2 && body.length >= 40
          ? `기준 ${items.length}개를 서두에 밝혔습니다`
          : '선정 기준 단락이 비었거나 너무 짧습니다. criteria.items 에 기준 2개 이상, '
            + 'criteria.paragraphs 에 왜 그 기준을 골랐는지 설명을 넣으세요.',
      };
    },
  },
  {
    id: 'table',
    label: '비교 표',
    prompt: () => '본문에 데이터 비교용 표(Table)를 최소 1개 반드시 포함할 것.',
    check: (post) => {
      const rows = post.table?.rows?.length || 0;
      const cols = post.table?.headers?.length || 0;
      return {
        ok: rows >= 2 && cols >= 2,
        detail: rows >= 2 && cols >= 2
          ? `표 ${rows}행 × ${cols}열`
          : '비교 표가 없습니다. table.headers 와 table.rows 를 2행 이상 채우세요.',
      };
    },
  },
  {
    id: 'bullets',
    label: '불렛 포인트',
    prompt: () => '주요 포인트는 불렛 포인트(목록)로 가독성 있게 정리할 것.',
    check: (post) => {
      const lists = (post.sections || []).reduce((total, section) => {
        const own = section.list?.length ? 1 : 0;
        const subs = (section.subsections || []).filter((sub) => sub.list?.length).length;
        return total + own + subs;
      }, 0);
      return {
        ok: lists >= 1,
        detail: lists >= 1 ? `목록 ${lists}개` : '불렛 포인트 목록이 하나도 없습니다.',
      };
    },
  },
  {
    id: 'detail',
    label: '항목별 상세',
    prompt: () => '단순 나열에 그치지 말고 각 항목마다 상세 설명, 특징, 장단점, 팁을 '
      + '세부 소제목으로 나눠 구체적으로 쓸 것.',
    enabledWhen: (settings, post) => post?.shape === 'items',
    check: (post) => {
      const itemSections = (post.sections || []).filter((section) => section.isItem);
      if (!itemSections.length) {
        return { ok: false, detail: '항목별 섹션이 없습니다.' };
      }
      const thin = itemSections.filter((section) => (section.subsections || []).length < 3);
      return {
        ok: thin.length === 0,
        detail: thin.length === 0
          ? `항목 ${itemSections.length}개에 각각 세부 소제목을 붙였습니다`
          : `세부 소제목이 3개 미만인 항목: ${thin.map((s) => s.heading).slice(0, 4).join(', ')}`
            + ' — 상세 설명 / 특징 / 장단점 / 팁 중 최소 3가지를 넣으세요.',
      };
    },
  },
  {
    id: 'opening',
    label: '서두 인사말 금지',
    prompt: () => '"안녕하세요", "이번 포스팅에서는" 같은 인사말이나 메타 안내 문장 없이 '
      + '바로 근황이나 이 주제를 찾아보게 된 사소한 계기로 시작할 것.',
    check: (post) => {
      const first = String((post.intro || [])[0] || '').trim();
      if (!first) return { ok: false, detail: '도입부가 비어 있습니다.' };
      if (GREETING.test(first)) {
        return { ok: false, detail: `인사말로 시작합니다: "${first.slice(0, 40)}"` };
      }
      if (META_SENTENCE.test(first)) {
        return { ok: false, detail: `메타 안내 문장으로 시작합니다: "${first.slice(0, 40)}"` };
      }
      return { ok: true, detail: '바로 본론으로 시작합니다' };
    },
  },
  {
    id: 'symbols',
    label: '기호·이모지',
    prompt: () => '특수문자(★, ※, ▶ 등)나 이모지를 본문에 쓰지 말고 깔끔한 텍스트 위주로 쓸 것.',
    check: (post) => {
      const text = allText(post);
      const bad = [...new Set(text.match(new RegExp(BANNED_SYMBOLS, 'gu')) || [])];
      const emoji = [...new Set(text.match(new RegExp(EMOJI, 'gu')) || [])];
      const found = [...bad, ...emoji];
      return {
        ok: found.length === 0,
        detail: found.length === 0
          ? '장식 기호 없음'
          : `본문에서 제거해야 할 기호: ${found.slice(0, 10).join(' ')}`,
      };
    },
  },
  {
    id: 'closing',
    label: '마무리',
    prompt: () => '억지로 요약하지 말고 내일 할 일이나 개인적인 다짐으로 덤덤하게 끝낼 것. '
      + '"이상으로 알아보았습니다", "도움이 되셨길 바랍니다" 같은 영혼 없는 마무리는 금지입니다.',
    check: (post) => {
      const outro = (post.outro || []).join(' ');
      const length = outro.replace(/\s+/g, '').length;
      // 덤덤한 마무리가 목표라 길이를 많이 요구하지 않는다. 한두 문장이면 충분하다.
      if (length < 50) {
        return {
          ok: false,
          detail: '마무리가 너무 짧습니다. 내일 할 일이나 다짐으로 한두 문장 더 붙여 자연스럽게 끝내세요.',
        };
      }
      return { ok: true, detail: '덤덤하게 마무리했습니다' };
    },
  },
];

/** 이 설정/글 모양에서 실제로 적용되는 규칙만 고른다. */
function activeRules(settings, post) {
  return RULES.filter((rule) => !rule.enabledWhen || rule.enabledWhen(settings, post));
}

/* ------------------------------------------------------------------ */
/* 프롬프트용 문장                                                      */
/* ------------------------------------------------------------------ */

/** 글을 쓰기 전에 넣을 "필수 준수 규칙" 블록. */
export function buildRuleBlock(settings, shape) {
  const rules = activeRules(settings, { shape });
  const lines = rules.map((rule, index) => `${index + 1}. [${rule.label}] ${rule.prompt(settings)}`);
  return [
    '[필수 준수 규칙 — 고품질 블로그 글 기준]',
    '아래는 이 글이 좋은 글로 평가받기 위한 조건입니다.',
    '하나라도 어기면 자동 검사에서 걸러져 다시 쓰게 됩니다.',
    '',
    ...lines,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 검사                                                                */
/* ------------------------------------------------------------------ */

/**
 * 완성된 글이 규칙을 지켰는지 본다.
 * @returns {{ok: boolean, passed: number, total: number, charCount: number,
 *            results: Array<{id,label,ok,detail}>, issues: Array<{id,label,detail}>}}
 */
export function checkCompliance(post, settings) {
  const results = activeRules(settings, post).map((rule) => {
    let outcome;
    try {
      outcome = rule.check(post, settings);
    } catch (error) {
      outcome = { ok: false, detail: `검사 중 오류: ${error.message}` };
    }
    return { id: rule.id, label: rule.label, ok: Boolean(outcome.ok), detail: outcome.detail || '' };
  });

  const issues = results.filter((result) => !result.ok);
  return {
    ok: issues.length === 0,
    passed: results.length - issues.length,
    total: results.length,
    charCount: countChars(post),
    results,
    issues: issues.map(({ id, label, detail }) => ({ id, label, detail })),
  };
}

/** 검사에서 걸린 항목만 짚어 다시 쓰게 하는 지시문. */
export function buildRepairBlock(compliance) {
  const lines = compliance.issues.map(
    (issue, index) => `${index + 1}. [${issue.label}] ${issue.detail}`,
  );
  return [
    '[수정 요청 — 아래 항목이 품질 검사에서 걸렸습니다]',
    '',
    ...lines,
    '',
    '위 문제만 정확히 고치세요. 통과한 부분은 그대로 두고,',
    '고친 결과를 같은 JSON 구조로 **전체** 출력하세요. 일부만 보내면 안 됩니다.',
  ].join('\n');
}

/** 대시보드 배지에 쓸 짧은 요약. */
export function summarize(compliance) {
  if (!compliance) return '';
  return compliance.ok
    ? `준수 ${compliance.passed}/${compliance.total}`
    : `미준수 ${compliance.issues.map((issue) => issue.label).join(', ')}`;
}
