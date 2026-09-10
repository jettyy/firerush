import { runClaudeJson } from '../ai/claude.js';
import { logger } from '../lib/events.js';

/**
 * "TOP100 순위" 같은 주제를 다루기 위한 모듈.
 *
 * 한 번의 호출로 100행짜리 표를 받으려고 하면 모델이 중간에 "이하 생략" 하거나
 * 출력 길이에 걸려 잘린다. 그래서 표는 구간을 나눠 여러 번 받아 이어 붙이고,
 * 빠진 순위가 있으면 그 구간만 다시 받는다.
 */

const CHUNK_SIZE = 25;
const MAX_COUNT = 200;

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
    // 표를 나눠 받아야 할 만큼 큰지. 10개 이하는 한 번에 받아도 안 잘린다.
    needsChunking: Boolean(count && count > 10),
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

function buildChunkPrompt({ topic, headers, start, end, existingNames, guidelineBlock }) {
  const expected = end - start + 1;
  // 예시 행은 반드시 실제 열 개수와 같아야 한다.
  // 3칸짜리 예시를 고정으로 보여주면 열이 4개여도 3칸만 채워서 돌려준다.
  const sampleRow = (rank) => JSON.stringify(
    [String(rank), ...headers.slice(1).map((header) => `${header} 내용`)],
  );

  return `${guidelineBlock}주제: "${topic}"

이 주제로 쓰는 블로그 글에 들어갈 **전체 순위 표**의 일부를 채워주세요.

[이번에 채울 범위]
${start}위부터 ${end}위까지, 정확히 ${expected}개 행.

[표의 열 구성]
${headers.map((header, index) => `${index + 1}. ${header}`).join('\n')}

[반드시 지킬 것]
- ${expected}개 행을 하나도 빠뜨리지 말고 모두 출력하세요.
- "이하 생략", "...", "(중략)", "나머지는 비슷합니다" 같은 표현은 절대 쓰지 마세요.
- 첫 번째 열에는 순위 숫자만 넣으세요 (${start}, ${start + 1}, ... ${end}).
- 각 행의 칸 수는 정확히 ${headers.length}개여야 합니다. 빈 칸을 남기지 말고 모두 채우세요.
- 각 칸은 25자 이내로 짧게 쓰세요. 길게 쓰면 표가 읽기 어려워집니다.
- 확실하지 않은 구체적 수치(정확한 매출액, 구독자 수 등)는 지어내지 말고 일반적인 설명으로 대체하세요.
${existingNames.length ? `- 아래 항목은 앞 구간에 이미 나왔습니다. 중복해서 넣지 마세요.\n  ${existingNames.slice(-60).join(', ')}` : ''}

[출력 형식]
JSON 객체 하나만 출력하세요. 설명도 코드 펜스도 붙이지 마세요.

{"rows": [${sampleRow(start)}, ${sampleRow(start + 1)}]}

각 행은 반드시 ${headers.length}개 칸(${headers.join(', ')})을 모두 가져야 합니다.`;
}

/**
 * 순위 표를 구간별로 나눠 받아 하나로 이어 붙인다.
 * 빠진 구간은 한 번 더 요청해서 메운다.
 */
export async function generateRankingRows({
  topic,
  headers,
  count,
  guidelineBlock = '',
  systemPrompt = '',
  signal,
  onProgress,
}) {
  const columnCount = headers.length;
  const byRank = new Map();
  let model = '';

  const fetchRange = async (start, end) => {
    const existingNames = [...byRank.values()].map((row) => row[1]).filter(Boolean);
    const prompt = buildChunkPrompt({ topic, headers, start, end, existingNames, guidelineBlock });
    const reply = await runClaudeJson(prompt, { systemPrompt, signal });
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
