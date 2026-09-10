import express from 'express';
import { PUBLIC_DIR, THUMB_DIR, OUTPUT_DIR, ensureDirs } from './lib/paths.js';
import { bus, recentLogs, logger } from './lib/events.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from './lib/settings.js';
import { listJobs, addTopics, removeJob, clearJobs, resetJob, stats, STATUS } from './lib/store.js';
import { parseTopics } from './lib/util.js';
import { openLoginWindow, verifySession, readSessionInfo, logout, closeContext } from './naver/browser.js';
import { previewThumbnailHtml } from './content/thumbnail.js';
import { checkClaude, runClaude } from './ai/claude.js';
import { MODELS } from './ai/models.js';
import { listExamples, addExample, removeExample, setExampleEnabled, MAX_EXAMPLE_CHARS } from './content/examples.js';
import { ensureBrowsers, closeRenderBrowser } from './lib/playwright.js';
import * as runner from './queue/runner.js';

ensureDirs();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/thumbnails', express.static(THUMB_DIR));
app.use('/posts', express.static(OUTPUT_DIR));

const wrap = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    logger.error(error.message);
    res.status(500).json({ ok: false, message: error.message });
  });
};

/* ---------- 상태 ---------- */

app.get('/api/state', wrap(async (req, res) => {
  res.json({
    ok: true,
    settings: getSettings(),
    defaults: DEFAULT_SETTINGS,
    models: MODELS,
    examples: listExamples(),
    session: readSessionInfo(),
    jobs: listJobs(),
    runner: runner.getRunnerState(),
    logs: recentLogs(),
    statuses: STATUS,
  });
}));

app.get('/api/health', wrap(async (req, res) => {
  const claude = await checkClaude();
  let browser = { ok: true, message: '' };
  try {
    await ensureBrowsers();
  } catch (error) {
    browser = { ok: false, message: error.message };
  }
  res.json({ ok: true, claude, browser, session: readSessionInfo() });
}));

/* 대시보드 실시간 갱신 (SSE) */
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});

/* ---------- 네이버 로그인 ---------- */

app.post('/api/login', wrap(async (req, res) => {
  res.json({ ok: true, message: '로그인 창을 띄웁니다. 브라우저에서 로그인해 주세요.' });
  openLoginWindow().catch((error) => logger.error(`로그인 실패: ${error.message}`));
}));

app.post('/api/login/verify', wrap(async (req, res) => {
  res.json({ ok: true, session: await verifySession({ headless: true }) });
}));

app.post('/api/logout', wrap(async (req, res) => {
  await logout();
  res.json({ ok: true });
}));

/* ---------- 주제 ---------- */

app.post('/api/topics/preview', wrap(async (req, res) => {
  const topics = parseTopics(req.body?.raw || '');
  res.json({ ok: true, count: topics.length, topics: topics.slice(0, 200) });
}));

app.post('/api/topics', wrap(async (req, res) => {
  const topics = parseTopics(req.body?.raw || '');
  if (!topics.length) {
    res.status(400).json({ ok: false, message: '주제를 한 줄에 하나씩 붙여넣어 주세요.' });
    return;
  }
  const added = addTopics(topics);
  logger.info(`주제 ${added.length}건을 추가했습니다. (붙여넣기 ${topics.length}건, 중복 제외)`);
  res.json({ ok: true, added: added.length, skipped: topics.length - added.length, jobs: listJobs() });
}));

app.delete('/api/jobs/:id', wrap(async (req, res) => {
  removeJob(req.params.id);
  res.json({ ok: true, jobs: listJobs() });
}));

app.post('/api/jobs/:id/retry', wrap(async (req, res) => {
  res.json({ ok: true, job: resetJob(req.params.id) });
}));

app.post('/api/jobs/clear', wrap(async (req, res) => {
  const jobs = clearJobs(Boolean(req.body?.onlyFinished));
  res.json({ ok: true, jobs });
}));

/* ---------- 실행 ---------- */

app.post('/api/run/start', wrap(async (req, res) => res.json(runner.start())));
app.post('/api/run/pause', wrap(async (req, res) => res.json(runner.pause())));
app.post('/api/run/stop', wrap(async (req, res) => res.json(runner.stop())));

/* ---------- AI 연결 테스트 ---------- */

/**
 * 85개를 돌리기 전에 지금 고른 모델로 실제 호출이 되는지 한 번 확인한다.
 * 모델을 못 쓰거나 로그인이 풀렸으면 여기서 바로 드러난다.
 */
app.post('/api/ai/test', wrap(async (req, res) => {
  const model = getSettings().claude.model;
  logger.step(`AI 연결 테스트 시작${model ? ` (${model})` : ''}`);
  try {
    const reply = await runClaude('"준비완료" 라고만 답하세요. 다른 말은 하지 마세요.', {
      systemPrompt: '당신은 짧게 답하는 도우미입니다.',
      timeoutMs: 120000,
    });
    logger.info(`AI 연결 테스트 성공 — 모델 ${reply.model}, 응답: ${reply.text.trim().slice(0, 40)}`);
    res.json({
      ok: true,
      model: reply.model,
      answer: reply.text.trim().slice(0, 100),
      durationMs: reply.durationMs,
    });
  } catch (error) {
    logger.error(`AI 연결 테스트 실패: ${error.message}`);
    res.json({ ok: true, failed: true, message: error.message, dumpFile: error.dumpFile || '' });
  }
}));

/* ---------- 참고 예시 ---------- */

app.get('/api/examples', wrap(async (req, res) => {
  res.json({ ok: true, examples: listExamples(), maxChars: MAX_EXAMPLE_CHARS });
}));

app.post('/api/examples', wrap(async (req, res) => {
  const { name, content } = req.body || {};
  if (!String(content || '').trim()) {
    res.status(400).json({ ok: false, message: '예시 내용이 비어 있습니다.' });
    return;
  }
  const entry = addExample({ name, content });
  res.json({ ok: true, entry, examples: listExamples() });
}));

app.post('/api/examples/:id/toggle', wrap(async (req, res) => {
  setExampleEnabled(req.params.id, req.body?.enabled);
  res.json({ ok: true, examples: listExamples() });
}));

app.delete('/api/examples/:id', wrap(async (req, res) => {
  removeExample(req.params.id);
  res.json({ ok: true, examples: listExamples() });
}));

/* ---------- 설정 / 미리보기 ---------- */

app.post('/api/settings', wrap(async (req, res) => {
  res.json({ ok: true, settings: saveSettings(req.body || {}) });
}));

app.get('/api/thumbnail/preview', wrap(async (req, res) => {
  res.type('html').send(previewThumbnailHtml({
    headline: req.query.headline,
    subline: req.query.subline,
    badge: req.query.badge,
    emoji: req.query.emoji,
    accent: req.query.accent,
    style: req.query.style,
  }));
}));

/* ---------- 시작 ---------- */

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, () => {
  logger.info(`대시보드가 열렸습니다 → http://localhost:${PORT}`);
  const { total, pending } = stats();
  logger.info(`저장된 주제 ${total}건 (대기 ${pending}건)`);
  ensureBrowsers().catch((error) => logger.error(`크로미움 준비 실패: ${error.message}`));
  verifySession({ headless: true }).catch(() => {});
});

async function shutdown() {
  logger.info('종료합니다...');
  runner.stop();
  await Promise.allSettled([closeContext(), closeRenderBrowser()]);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
