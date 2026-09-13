import { runClaudeJson } from '../ai/claude.js';
import { logger } from '../lib/events.js';
import { getSettings } from '../lib/settings.js';

/**
 * 주제의 "모양"을 정하는 모듈.
 *
 * 품질 규칙은 "각 항목마다 상세 설명 / 특징 / 장단점 / 팁을 구체적으로 쓸 것" 을
 * 요구한다. 그래서 항목이 몇 개냐에 따라 글의 구조를 다르게 잡아야 한다.
 *
 *   - TOP 5, 7가지 처럼 항목이 적으면  → 항목마다 섹션 하나 + 세부 소제목 (items)
 *   - TOP 50, 100가지 처럼 많으면       → 큰 표 하나 + 대표 항목만 상세 (table)
 *   - 개수가 없는 일반 정보성 주제        → 소제목 중심 (general)
 *
 * 표를 100행 받는 일은 한 번의 호출로 안 된다. 모델이 "이하 생략" 하거나
 * 출력 길이에 걸려 잘리기 때문에 구간을 나눠 받아 이어 붙이고,
 * 빠진 순위가 있으면 그 구간만 다시 받는다.
 */

/** 이 개수까지는 항목마다 상세 섹션을 쓴다. 넘어가면 글이 감당이 안 된다. */
export const ITEM_LIMIT = 12;

/**
 * "OO 순위" 처럼 개수를 안 밝힌 주제에 잡아줄 기본 표 크기.
 *
 * 개수를 안 썼다고 5~6개만 적으면 검색해서 들어온 사람이 바로 나가버린다.
 * 넉넉하게 잡아두고, 모델이 아는 만큼만 채우게 둔다. (못 채운 행은 버린다)
 * 설정(post.rankCount)으로 바꿀 수 있다.
 */
export const DEFAULT_RANK_COUNT = 100;

/**
 * 표 행만 나눠 받을 때 한 번에 요청하는 행 수.
 *
 * 한 번에 많이 달라고 하면 모델이 앞쪽만 성의 있게 채우고 뒤쪽을 흐지부지 끝낸다.
 * 25개씩 끊으면 호출이 늘어나는 대신 구간마다 끝까지 채워준다.
 */
const CHUNK_SIZE = 25;
const MAX_COUNT = 300;

/** 빠진 구간을 다시 채우는 시도 횟수. 100행짜리는 구멍이 여러 군데 날 수 있다. */
const MAX_REFILL_RANGES = 8;

/** 표 행만 뽑는 호출에는 블로그 작법 지시가 필요 없다. 짧을수록 싸고 빠르다. */
const ROW_SYSTEM = '표 데이터를 JSON 으로만 출력합니다. 설명을 붙이지 않습니다.';

/** 주제 문자열에서 "몇 개짜리 글인지" 알아낸다. */
export function detectCount(topic) {
  const text = String(topic || '');
  const patterns = [
    /top\s*-?\s*(\d{1,3})/i,
    /best\s*-?\s*(\d{1,3})/i,
    /베스트\s*(\d{1,3})/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)\b/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)/,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched) {
      const parsed = Number(matched[1]);
      if (Number.isFinite(parsed) && parsed >= 2 && parsed <= MAX_COUNT) return parsed;
    }
  }
  return null;
}

/**
 * 글의 모양을 정한다.
 * @returns {{shape: 'items'|'table'|'general', count: number|null, needsChunking: boolean}}
 */
export function detectShape(topic) {
  const text = String(topic || '');
  const count = detectCount(text);

  // "순위 / 랭킹 / TOP / 베스트" — 개수를 안 밝혀도 목록을 최대한 많이 원하는 주제.
  const rankWord = /(순위|랭킹|랭크|\branking\b|\brank\b|\btop\s*-?\s*\d*|베스트|\bbest\b)/i.test(text);
  // "추천 / 비교 / 고르는 법" — 개수보다 설명이 중요한 주제.
  const pickWord = /(추천|고르는|고르기|비교|선택하는)/.test(text);

  if (count && count <= ITEM_LIMIT) {
    return { shape: 'items', count, needsChunking: false };
  }
  if (count) {
    return { shape: 'table', count, needsChunking: true };
  }
  if (rankWord) {
    // 개수를 안 썼어도 표를 넉넉히 채운다. 자료가 모자라면 채워진 만큼만 남는다.
    const wanted = Number(getSettings().post?.rankCount) || DEFAULT_RANK_COUNT;
    const target = Math.max(10, Math.min(MAX_COUNT, wanted));
    return { shape: 'table', count: target, needsChunking: true, openEnded: true };
  }
  if (pickWord) {
    return { shape: 'items', count: null, needsChunking: false };
  }
  return { shape: 'general', count: null, needsChunking: false };
}

function normalizeRows(rawRows, columnCount) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows
    .map((row) => {
      if (Array.isArray(row)) return row.map((cell) => String(cell ?? '').trim());
      if (row && typeof row === 'object') return Object.values(row).map((cell) => String(cell ?? '').trim());
      return null;
    })
    .filter(Boolean)
    .map((cells) => {
      const fixed = cells.slice(0, columnCount);
      while (fixed.length < columnCount) fixed.push('');
      return fixed;
    })
    .filter((cells) => cells.some((cell) => cell));
}

/** 행의 첫 칸에서 순위 숫자를 뽑는다. "1위", "1." 같은 표기도 허용. */
function rankOf(row) {
  const matched = String(row?.[0] ?? '').match(/\d+/);
  return matched ? Number(matched[0]) : null;
}

function buildChunkPrompt({ topic, headers, start, end, existingNames, total }) {
  const expected = end - start + 1;
  // 뒤쪽 구간일수록 "유명한 것"만 찾으면 칸이 빈다.
  // 앞에서 이미 다 나갔기 때문이다. 범위를 넓히라고 분명히 일러준다.
  const deep = start > Math.max(20, Math.round(total * 0.25));
  // 예시 행은 반드시 실제 열 개수와 같아야 한다.
  // 3칸짜리 예시를 고정으로 보여주면 열이 4개여도 3칸만 채워서 돌려준다.
  const sampleRow = (rank) => JSON.stringify(
    [String(rank), ...headers.slice(1).map((header) => `${header} 내용`)],
  );

  return `주제: "${topic}"
이 주제의 비교표에서 ${start}~${end}번, ${expected}개 행을 채우세요.

열: ${headers.join(' | ')}

규칙
- 아는 것을 최대한 끌어모아 ${expected}개를 꽉 채우는 것이 목표입니다. "이하 생략", "...", "(중략)" 금지.
- 실제로 존재하는 항목의 이름을 쓰세요. 칸을 메우려고 "항목 1", "기타" 같은 가짜 항목을 만들지 마세요.
${deep ? `- 여기는 ${total}개 중 뒤쪽 구간입니다. 아주 유명한 것은 앞 구간에서 이미 다 나갔습니다.
  덜 알려진 곳, 지방·지역에 있는 곳, 규모가 작은 곳, 전문·특수 분야까지 넓혀서 채우세요.
  유명한 것만 찾으려 하면 이 구간은 절대 못 채웁니다. 범위를 넓히는 것이 이 구간의 핵심입니다.`
    : '- 앞 구간이므로 가장 대표적이고 널리 알려진 것부터 채우세요.'}
- 이 주제에 해당하는 것이 ${expected}개보다 적다면, 아는 만큼만 출력하고 나머지 번호는 빼세요.
  억지로 지어내는 것보다 적게 나오는 편이 낫습니다.
- 첫 칸은 번호 숫자만 (${start}~${end}).
- 각 행은 정확히 ${headers.length}칸, 빈 칸 없이.
- 각 칸 24자 이내. 특수문자와 이모지는 쓰지 마세요.
- 공식 조사 결과가 아니라 널리 알려진 정보를 모은 참고용 표입니다. 실제 조사 수치는 지어내지 말고 일반적인 특징으로 채우세요.
${existingNames.length ? `- 이미 나온 항목 제외: ${existingNames.slice(-60).join(', ')}` : ''}

JSON 만 출력:
{"rows": [${sampleRow(start)}, ${sampleRow(start + 1)}]}`;
}

/**
 * 큰 표를 구간별로 나눠 받아 하나로 이어 붙인다.
 * 빠진 구간은 한 번 더 요청해서 메운다.
 */
export async function generateTableRows({
  topic,
  headers,
  count,
  signal,
  onProgress,
}) {
  const columnCount = headers.length;
  const byRank = new Map();
  let model = '';

  // 표 행 채우기는 판단력이 거의 필요 없는 나열 작업이라 본문보다 싼 모델로 돌린다.
  const settings = getSettings();
  const rowModel = settings.claude.tableModel || settings.claude.model;
  if (rowModel && rowModel !== settings.claude.model) {
    logger.info(`표의 행은 ${rowModel} 으로 채웁니다. (본문과 따로)`);
  }

  const fetchRange = async (start, end) => {
    const existingNames = [...byRank.values()].map((row) => row[1]).filter(Boolean);
    const prompt = buildChunkPrompt({ topic, headers, start, end, existingNames, total: count });
    const reply = await runClaudeJson(prompt, { systemPrompt: ROW_SYSTEM, signal, model: rowModel });
    model = reply.model || model;

    for (const row of normalizeRows(reply.data?.rows, columnCount)) {
      const rank = rankOf(row);
      // 범위 밖이거나 번호를 못 읽은 행은 버린다. 순서가 꼬이는 것보다 낫다.
      if (rank === null || rank < 1 || rank > count) continue;
      row[0] = String(rank);
      byRank.set(rank, row);
    }
  };

  for (let start = 1; start <= count; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, count);
    await fetchRange(start, end);
    onProgress?.({ filled: byRank.size, total: count });
    logger.info(`비교표 ${start}~${end}번 생성 (누적 ${byRank.size}/${count}개)`);
  }

  // 빠진 번호를 연속 구간으로 묶어 한 번씩만 다시 요청한다.
  const missing = [];
  for (let rank = 1; rank <= count; rank += 1) {
    if (!byRank.has(rank)) missing.push(rank);
  }

  if (missing.length) {
    logger.warn(`${missing.length}개 행이 비어 다시 채웁니다: ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ' ...' : ''}`);
    const ranges = [];
    let head = missing[0];
    let prev = missing[0];
    for (const rank of missing.slice(1)) {
      if (rank === prev + 1) { prev = rank; continue; }
      ranges.push([head, prev]);
      head = rank;
      prev = rank;
    }
    ranges.push([head, prev]);

    // 자료가 정말 없어서 비는 경우도 있다. 재요청 횟수는 정해두고 접는다.
    for (const [start, end] of ranges.slice(0, MAX_REFILL_RANGES)) {
      try {
        await fetchRange(start, end);
      } catch (error) {
        logger.warn(`${start}~${end}번 재생성 실패: ${error.message}`);
      }
    }
  }

  const rows = [];
  const stillMissing = [];
  for (let rank = 1; rank <= count; rank += 1) {
    const row = byRank.get(rank);
    if (row) rows.push(row);
    else stillMissing.push(rank);
  }

  // 끝내 못 채운 번호가 있으면 표에 구멍이 생긴다.
  // 순서는 그대로 두고 번호만 1부터 다시 매겨서 끊김 없이 읽히게 한다.
  if (stillMissing.length) {
    rows.forEach((row, index) => { row[0] = String(index + 1); });
  }

  // 열을 통째로 비워서 돌려주는 경우가 있어 채움 상태를 짚어둔다.
  const emptyCells = rows.reduce(
    (total, row) => total + row.filter((cell) => !cell).length,
    0,
  );
  if (emptyCells > rows.length * 0.2) {
    logger.warn(`표에 빈 칸이 ${emptyCells}개 있습니다. 열 구성이 복잡하면 줄이는 편이 낫습니다.`);
  }

  return { rows, model, missing: stillMissing, emptyCells };
}
