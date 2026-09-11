import fs from 'node:fs';
import path from 'node:path';
import { STATUS, updateJob, nextPending, stats } from '../lib/store.js';
import { getSettings } from '../lib/settings.js';
import { generatePost, countChars } from '../content/generator.js';
import { renderThumbnail } from '../content/thumbnail.js';
import { buildPreviewHtml } from '../content/html.js';
import { publishDraft } from '../naver/editor.js';
import { readSessionInfo, verifySession } from '../naver/browser.js';
import { OUTPUT_DIR, ensureDirs } from '../lib/paths.js';
import { logger, push } from '../lib/events.js';
import { sleep, randomBetween, slugify } from '../lib/util.js';

const state = {
  running: false,
  paused: false,
  currentJobId: null,
  abort: null,
  waitUntil: null,
};

export function getRunnerState() {
  return {
    running: state.running,
    paused: state.paused,
    currentJobId: state.currentJobId,
    waitUntil: state.waitUntil,
    stats: stats(),
  };
}

function broadcast() {
  push('runner', getRunnerState());
}

/** 결과물을 파일로도 남겨둔다. 네이버 자동화가 실패해도 글은 살아 있게. */
function archivePost(job, post, thumbnailPath) {
  ensureDirs();
  const base = `${slugify(job.topic, 30)}-${job.id}`;
  const dir = path.join(OUTPUT_DIR, base);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify(post, null, 2), 'utf8');
  const thumbName = thumbnailPath ? path.basename(thumbnailPath) : '';
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    fs.copyFileSync(thumbnailPath, path.join(dir, thumbName));
  }
  fs.writeFileSync(path.join(dir, 'preview.html'), buildPreviewHtml(post, thumbName), 'utf8');
  return dir;
}

async function processJob(job) {
  state.currentJobId = job.id;
  broadcast();

  updateJob(job.id, {
    status: STATUS.WRITING,
    message: 'AI가 글을 쓰는 중...',
    attempts: job.attempts + 1,
  });
  logger.step(`[${job.topic}] 글 생성 시작`, { jobId: job.id });

  const post = await generatePost(job.topic, { signal: state.abort?.signal });
  const charCount = countChars(post);
  const tableRows = post.table?.rows?.length || 0;

  const notes = [`${charCount}자`];
  if (tableRows) {
    notes.push(post.rankingExpected
      ? `표 ${tableRows}/${post.rankingExpected}행`
      : `표 ${tableRows}행`);
  }
  if (post.rankingMissing?.length) notes.push(`누락 ${post.rankingMissing.length}건`);

  updateJob(job.id, {
    title: post.title,
    charCount,
    tableRows,
    model: post.model,
    guidelineCheck: post.guidelineCheck,
    message: `초안 완성 (${notes.join(', ')})`,
  });
  logger.info(
    `[${job.topic}] 초안 완성: "${post.title}" — ${notes.join(', ')}` +
    `${post.model ? ` / 모델 ${post.model}` : ''}`,
    { jobId: job.id },
  );
  if (post.guidelineCheck) {
    logger.info(`[${job.topic}] 지침 반영: ${post.guidelineCheck}`, { jobId: job.id });
  }

  updateJob(job.id, { status: STATUS.THUMBNAIL, message: '썸네일 만드는 중...' });
  const thumb = await renderThumbnail(post, { jobId: job.id });
  updateJob(job.id, { thumbnailPath: thumb.fileName, message: `썸네일 완성 (${thumb.style})` });

  const dir = archivePost(job, post, thumb.filePath);

  updateJob(job.id, { status: STATUS.POSTING, message: '네이버 에디터에 옮기는 중...' });
  const result = await publishDraft({ post, thumbnailPath: thumb.filePath, jobId: job.id });

  updateJob(job.id, {
    status: STATUS.DONE,
    message: result.confirmed
      ? '임시저장 완료'
      : '임시저장 요청함 (저장 완료 표시 미확인)',
    archiveDir: path.basename(dir),
  });
  logger.info(`[${job.topic}] 임시저장 완료`, { jobId: job.id });
}

// 같은 이유로 계속 실패할 때 남은 주제를 전부 태우지 않도록 하는 한계선.
const STOP_AFTER_FAILURES = 3;

async function loop() {
  let processed = 0;
  let consecutiveFailures = 0;

  // 계정을 바꿔 로그인했을 수 있으니 시작 전에 블로그 아이디를 다시 맞춘다.
  // 이전 계정의 아이디로 글쓰기를 시도하면 남의 블로그가 열려 아무것도 못 한다.
  try {
    const info = await verifySession();
    if (info.loggedIn) {
      logger.info(`대상 블로그: ${info.blogId || '(아이디 미확인)'}`);
    } else {
      // 확인이 어긋났다고 실행 자체를 막지는 않는다.
      // 정말 로그아웃이면 첫 글에서 분명한 오류가 나고, 연속 실패 차단이 멈춰준다.
      logger.warn('로그인 상태를 확인하지 못했습니다. 그대로 진행해 봅니다.');
    }
  } catch (error) {
    logger.warn(`시작 전 세션 확인을 건너뜁니다: ${error.message}`);
  }

  while (state.running) {
    if (state.paused) {
      await sleep(700);
      continue;
    }

    const job = nextPending();
    if (!job) {
      logger.info('대기 중인 주제가 없습니다. 실행을 마칩니다.');
      break;
    }

    try {
      await processJob(job);
      consecutiveFailures = 0;
    } catch (error) {
      const message = error.message || String(error);

      // 사용량 한도는 계속 돌려도 전부 실패한다. 멈추고 사람이 판단하게 둔다.
      if (error.rateLimited) {
        updateJob(job.id, { status: STATUS.PENDING, message: `사용량 한도로 대기: ${message}` });
        state.paused = true;
        logger.error(`사용량 한도에 걸려 일시정지했습니다. 잠시 뒤 [이어서 실행]을 눌러주세요. ${message}`);
        broadcast();
        continue;
      }

      consecutiveFailures += 1;
      const canRetry = job.attempts <= getSettings().run.maxRetries;
      if (canRetry && state.running) {
        updateJob(job.id, { status: STATUS.PENDING, message: `실패, 재시도 예정: ${message}` });
        logger.warn(`[${job.topic}] 실패 - 재시도합니다. ${message}`, { jobId: job.id });
        await sleep(5000);
      } else {
        updateJob(job.id, { status: STATUS.FAILED, message });
        logger.error(`[${job.topic}] 실패: ${message}`, { jobId: job.id });
      }

      // 설정이 잘못됐거나 CLI 가 죽은 상태라면 남은 주제도 전부 같은 이유로 실패한다.
      // 85건을 몇 초 만에 실패로 태우는 대신 멈춰서 알린다.
      if (consecutiveFailures >= STOP_AFTER_FAILURES) {
        logger.error(
          `연속 ${consecutiveFailures}건이 같은 이유로 실패해 실행을 멈춥니다. ` +
          `마지막 오류: ${message}`,
        );
        state.running = false;
      }
    } finally {
      state.currentJobId = null;
      broadcast();
    }

    processed += 1;
    if (!state.running) break;
    if (!nextPending()) break;

    // 사람처럼 보이도록 글 사이에 무작위로 쉰다.
    const { delayMinSec, delayMaxSec } = getSettings().run;
    const wait = randomBetween(
      Math.max(0, delayMinSec) * 1000,
      Math.max(delayMinSec, delayMaxSec) * 1000,
    );
    state.waitUntil = Date.now() + wait;
    broadcast();
    logger.info(`다음 글까지 ${Math.round(wait / 1000)}초 대기합니다.`);

    const until = Date.now() + wait;
    while (Date.now() < until && state.running) await sleep(500);
    state.waitUntil = null;
  }

  state.running = false;
  state.paused = false;
  state.currentJobId = null;
  state.waitUntil = null;
  broadcast();
  logger.info(`실행 종료. 이번 실행에서 ${processed}건 처리했습니다.`);
}

export function start() {
  if (state.running) return { ok: false, message: '이미 실행 중입니다.' };
  if (!nextPending()) return { ok: false, message: '대기 중인 주제가 없습니다.' };

  const session = readSessionInfo();
  if (!session.loggedIn) return { ok: false, message: '먼저 네이버에 로그인해 주세요.' };
  if (!getSettings().blogId) return { ok: false, message: '블로그 아이디를 설정에서 입력해 주세요.' };

  state.running = true;
  state.paused = false;
  state.abort = new AbortController();
  broadcast();
  logger.info(`실행 시작 - 대기 ${stats().pending}건`);
  loop().catch((error) => {
    logger.error(`실행 루프 오류: ${error.message}`);
    state.running = false;
    broadcast();
  });
  return { ok: true };
}

export function pause() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.paused = !state.paused;
  broadcast();
  logger.info(state.paused ? '일시정지했습니다.' : '다시 시작합니다.');
  return { ok: true, paused: state.paused };
}

export function stop() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.running = false;
  state.paused = false;
  state.abort?.abort();
  broadcast();
  logger.info('중지 요청을 받았습니다. 진행 중인 글을 마치고 멈춥니다.');
  return { ok: true };
}
