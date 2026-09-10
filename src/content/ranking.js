import { runClaudeJson } from '../ai/claude.js';
import { logger } from '../lib/events.js';

/**
 * "TOP100 순위" 같은 주제를 다루기 위한 모듈.
 *
 * 한 번의 호출로 100행짜리 표를 받으려고 하면 모델이 중간에 "이하 생략" 하거나
 * 출력 길이에 걸려 잘린다. 그래서 표는 구간을 나눠 여러 번 받아 이어 붙이고,
 * 빠진 순위가 있으면 그 구간만 다시 받는다.
 */

/**
 * claude -p 는 호출 한 번당 CLI 자체 시스템 프롬프트로만 3만 토큰 넘게 쓴다.
 * 그래서 토큰과 시간을 줄이는 가장 큰 지렛대는 "호출 횟수를 줄이는 것" 이다.
 * 한 번에 받는 행 수를 늘려 호출을 줄인다.
 */
const CHUNK_SIZE = 50;
const MAX_COUNT = 200;

/** 이 개수까지는 본문과 표를 한 번의 호출로 같이 받는다. */
export const SINGLE_CALL_LIMIT = 40;

/** 표 행만 뽑는 호출에는 블로그 작법 지시가 필요 없다. 짧을수록 싸고 빠르다. */
const ROW_SYSTEM = '표 데이터를 JSON 으로만 출력합니다. 설명을 붙이지 않습니다.';

/** 주제 문자열에서 "몇 개짜리 순위 글인지" 알아낸다. */
export function detectRanking(topic) {
  const text = String(topic || '');
  const isRankingWord = /(순위|랭킹|랭크|ranking|rank|top\s*-?\s*\d|베스트|best\s*\d)/i.test(text);

  const patterns = [
    /top\s*-?\s*(\d{1,3})/i,
    /best\s*-?\s*(\d{1,3})/i,
    /베스트\s*(\d{1,3})/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)\b/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)/,
  ];

  let count = null;
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched) {
      const parsed = Number(matched[1]);
      if (Number.isFinite(parsed) && parsed >= 2 && parsed <= MAX_COUNT) {
        count = parsed;
        break;
      }
    }
  }

  return {
    isRanking: Boolean(isRankingWord || count),
    count,
    // 호출 한 번이 비싸므로 웬만하면 한 번에 받는다.
    // 40개 정도까지는 본문과 같이 받아도 잘리지 않는다.
    needsChunking: Boolean(count && count > SINGLE_CALL_LIMIT),
  };
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

function buildChunkPrompt({ topic, headers, start, end, existingNames }) {
  const expected = end - start + 1;
  // 예시 행은 반드시 실제 열 개수와 같아야 한다.
  // 3칸짜리 예시를 고정으로 보여주면 열이 4개여도 3칸만 채워서 돌려준다.
  const sampleRow = (rank) => JSON.stringify(
    [String(rank), ...headers.slice(1).map((header) => `${header} 내용`)],
  );

  return `주제: "${topic}"
이 주제의 순위표에서 ${start}~${end}위, 정확히 ${expected}개 행을 채우세요.

열: ${headers.join(' | ')}

규칙
- ${expected}개 행 전부 출력. "이하 생략", "...", "(중략)" 금지.
- 첫 칸은 순위 숫자만 (${start}~${end}).
- 각 행은 정확히 ${headers.length}칸, 빈 칸 없이.
- 각 칸 20자 이내.
- 공식 조사 결과가 아니라 널리 알려진 정보를 모은 참고용 표입니다. 실제 조사 수치는 지어내지 말고 일반적인 특징으로 채우세요.
${existingNames.length ? `- 이미 나온 항목 제외: ${existingNames.slice(-60).join(', ')}` : ''}

JSON 만 출력:
{"rows": [${sampleRow(start)}, ${sampleRow(start + 1)}]}`;
}

/**
 * 순위 표를 구간별로 나눠 받아 하나로 이어 붙인다.
 * 빠진 구간은 한 번 더 요청해서 메운다.
 */
export async function generateRankingRows({
  topic,
  headers,
  count,
  signal,
  onProgress,
}) {
  const columnCount = headers.length;
  const byRank = new Map();
  let model = '';

  const fetchRange = async (start, end) => {
    const existingNames = [...byRank.values()].map((row) => row[1]).filter(Boolean);
    const prompt = buildChunkPrompt({ topic, headers, start, end, existingNames });
    const reply = await runClaudeJson(prompt, { systemPrompt: ROW_SYSTEM, signal });
    model = reply.model || model;

    for (const row of normalizeRows(reply.data?.rows, columnCount)) {
      const rank = rankOf(row);
      // 범위 밖이거나 순위를 못 읽은 행은 버린다. 순서가 꼬이는 것보다 낫다.
      if (rank === null || rank < 1 || rank > count) continue;
      row[0] = String(rank);
      byRank.set(rank, row);
    }
  };

  for (let start = 1; start <= count; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, count);
    await fetchRange(start, end);
    onProgress?.({ filled: byRank.size, total: count });
    logger.info(`순위 표 ${start}~${end}위 생성 (누적 ${byRank.size}/${count}개)`);
  }

  // 빠진 순위를 연속 구간으로 묶어 한 번씩만 다시 요청한다.
  const missing = [];
  for (let rank = 1; rank <= count; rank += 1) {
    if (!byRank.has(rank)) missing.push(rank);
  }

  if (missing.length) {
    logger.warn(`순위 ${missing.length}개가 비어 다시 채웁니다: ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ' ...' : ''}`);
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

    for (const [start, end] of ranges) {
      try {
        await fetchRange(start, end);
      } catch (error) {
        logger.warn(`${start}~${end}위 재생성 실패: ${error.message}`);
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
