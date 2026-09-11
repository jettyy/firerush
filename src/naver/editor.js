import path from 'node:path';
import { SELECTORS, findFirst, clickIfPresent } from './selectors.js';
import { getContext } from './browser.js';
import { getSettings } from '../lib/settings.js';
import { SHOT_DIR, ensureDirs } from '../lib/paths.js';
import { logger } from '../lib/events.js';
import { buildIntroHtml, buildBodyBlocks, htmlToPlainText, BLOCK_GAP } from '../content/html.js';

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * 에디터가 iframe(#mainFrame) 안에 있을 수도, 페이지 자체일 수도 있다.
 * 못 찾으면 null 을 돌려준다 (주소를 바꿔가며 여러 번 시도하기 위해).
 */
async function findEditorScope(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return null;
    for (const frame of page.frames()) {
      for (const selector of SELECTORS.editorReady) {
        const found = await frame
          .locator(selector)
          .first()
          .isVisible({ timeout: 200 })
          .catch(() => false);
        if (found) return frame;
      }
    }
    await page.waitForTimeout(400).catch(() => {});
  }
  return null;
}

/**
 * 글쓰기 화면을 연다.
 *
 * 저장된 블로그 아이디가 지금 로그인한 계정의 것이 아니면 (계정을 바꿨을 때)
 * ?Redirect=Write 주소는 글쓰기로 가지 않고 그냥 그 블로그 홈을 보여준다.
 * 그래서 주소를 여러 개 시도하고, 그래도 안 되면 블로그 화면의 글쓰기 링크를 누른다.
 */
async function openWriteEditor(page, blogId, jobId) {
  const candidates = [
    `https://blog.naver.com/${blogId}/postwrite`,
    `https://blog.naver.com/${blogId}?Redirect=Write&`,
    `https://blog.naver.com/PostWriteForm.naver?blogId=${blogId}`,
  ];

  for (const url of candidates) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const scope = await findEditorScope(page, 12000);
    if (scope) {
      logger.info(`글쓰기 화면 진입: ${url}`, { jobId });
      return { scope, page };
    }
    logger.warn(`글쓰기 화면이 아닙니다 (${page.url()}). 다음 방법을 시도합니다.`, { jobId });
  }

  // 마지막 수단: 블로그 화면에서 글쓰기 링크를 직접 누른다.
  logger.step('블로그 화면에서 글쓰기 버튼을 찾아 누릅니다.', { jobId });
  await page.goto(`https://blog.naver.com/${blogId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
  await page.waitForTimeout(1500);

  for (const frame of page.frames()) {
    const clicked = await clickIfPresent(frame, SELECTORS.writeLink, 2000);
    if (!clicked) continue;
    logger.info(`글쓰기 링크를 눌렀습니다 (${clicked})`, { jobId });
    await page.waitForTimeout(2500);

    const scope = await findEditorScope(page, 15000);
    if (scope) return { scope, page };

    // 새 창으로 열렸을 수도 있다.
    const pages = page.context().pages();
    for (const candidate of pages) {
      if (candidate === page || candidate.isClosed()) continue;
      const popupScope = await findEditorScope(candidate, 8000);
      if (popupScope) {
        logger.info('글쓰기가 새 창으로 열렸습니다.', { jobId });
        return { scope: popupScope, page: candidate };
      }
    }
  }

  throw new Error(
    `글쓰기 화면을 열지 못했습니다. 현재 주소: ${page.url()} — ` +
    `블로그 아이디(${blogId})가 지금 로그인한 계정의 것이 맞는지 확인해 주세요. ` +
    `계정을 바꾸셨다면 대시보드에서 [세션 확인]을 누르거나 설정에서 아이디를 고쳐주세요.`,
  );
}

async function dismissPopups(scope) {
  // "작성 중인 글이 있습니다" -> 취소를 눌러 새 글로 시작한다.
  const cancelled = await clickIfPresent(scope, SELECTORS.draftPopupCancel, 3000);
  if (cancelled) logger.info('이어쓰기 팝업을 닫고 새 글로 시작합니다.');
  await clickIfPresent(scope, SELECTORS.helpPanelClose, 1500);
}

async function typeInto(page, locator, text) {
  await locator.click({ timeout: 10000 });
  await page.waitForTimeout(150);
  try {
    await page.keyboard.insertText(text);     // 한글은 insertText 가 가장 안정적이다.
  } catch {
    await page.keyboard.type(text, { delay: 12 });
  }
}

async function bodyTextLength(scope) {
  return scope
    .evaluate(() => {
      const root = document.querySelector('.se-main-container') || document.body;
      return (root.innerText || '').length;
    })
    .catch(() => 0);
}

/**
 * 서식을 살려 넣는 유일하게 안정적인 방법이 HTML 붙여넣기다.
 * 1) 합성 paste 이벤트 -> 2) 실제 클립보드 + Ctrl+V -> 3) 평문 타이핑 순으로 시도한다.
 */
async function pasteHtml(page, scope, html) {
  const text = htmlToPlainText(html);
  const before = await bodyTextLength(scope);

  const trySynthetic = async () => {
    await scope.evaluate(({ html, text }) => {
      const target = document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : document.querySelector('.se-main-container') || document.body;
      const data = new DataTransfer();
      data.setData('text/html', html);
      data.setData('text/plain', text);
      target.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }));
    }, { html, text });
    await page.waitForTimeout(700);
    return (await bodyTextLength(scope)) > before + Math.min(20, text.length / 2);
  };

  const tryClipboard = async () => {
    await scope.evaluate(async ({ html, text }) => {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
    }, { html, text });
    await page.keyboard.press(`${MODIFIER}+V`);
    await page.waitForTimeout(900);
    return (await bodyTextLength(scope)) > before + Math.min(20, text.length / 2);
  };

  try {
    if (await trySynthetic()) return 'synthetic-paste';
  } catch (error) {
    logger.warn(`합성 붙여넣기 실패: ${error.message.split('\n')[0]}`);
  }

  try {
    if (await tryClipboard()) return 'clipboard';
  } catch (error) {
    logger.warn(`클립보드 붙여넣기 실패: ${error.message.split('\n')[0]}`);
  }

  // 마지막 수단: 서식 없이 평문으로라도 넣는다.
  logger.warn('서식 붙여넣기에 실패해 평문으로 입력합니다.');
  for (const line of text.split('\n')) {
    if (line.trim()) {
      try {
        await page.keyboard.insertText(line);
      } catch {
        await page.keyboard.type(line, { delay: 8 });
      }
    }
    await page.keyboard.press('Enter');
  }
  return 'plain-text';
}

/** 현재 커서 위치에 이미지를 넣는다. */
async function insertImage(page, scope, imagePath) {
  const { locator } = await findFirst(scope, SELECTORS.imageButton, 10000);

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 20000 }),
    locator.click({ timeout: 10000 }),
  ]);
  await chooser.setFiles(path.resolve(imagePath));

  // 업로드가 끝나 이미지 컴포넌트가 붙을 때까지 기다린다.
  await scope
    .waitForSelector('.se-component.se-image, .se-image-resource', { timeout: 60000 })
    .catch(() => {
      throw new Error('썸네일 업로드가 완료되지 않았습니다.');
    });
  await page.waitForTimeout(1200);

  // 이미지 다음 줄로 커서를 옮겨 본문이 이어지게 한다.
  await page.keyboard.press('ArrowDown').catch(() => {});
  await page.keyboard.press('End').catch(() => {});
}

async function saveDraft(page, scope) {
  const { locator, selector } = await findFirst(scope, SELECTORS.saveButton, 15000);
  await locator.click({ timeout: 10000 });
  logger.info(`임시저장 버튼을 눌렀습니다. (${selector})`);

  for (const toast of SELECTORS.saveToast) {
    const seen = await scope
      .locator(toast)
      .first()
      .waitFor({ state: 'visible', timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (seen) return true;
  }

  // 토스트를 못 잡아도 저장은 됐을 수 있다. 경고만 남기고 진행한다.
  await page.waitForTimeout(2500);
  logger.warn('저장 완료 표시를 확인하지 못했습니다. 네이버 임시저장 목록에서 확인해 주세요.');
  return false;
}

async function captureFailure(page, jobId) {
  if (!getSettings().run.screenshotOnError) return '';
  try {
    ensureDirs();
    const file = path.join(SHOT_DIR, `${Date.now()}-${jobId || 'error'}.png`);
    await page.screenshot({ path: file, fullPage: false });
    logger.warn(`오류 화면을 저장했습니다: ${file}`);
    return file;
  } catch {
    return '';
  }
}

/**
 * 글 한 편을 네이버 블로그 에디터에 옮겨 적고 임시저장한다.
 * 도입부 -> 썸네일 -> 본문 순서라 이미지가 글 상단 1/3 안에 들어간다.
 */
export async function publishDraft({ post, thumbnailPath, jobId = '' }) {
  const settings = getSettings();
  const blogId = settings.blogId;
  if (!blogId) throw new Error('블로그 아이디가 없습니다. 로그인하거나 설정에서 입력해 주세요.');

  const context = await getContext();
  const opener = await context.newPage();
  opener.setDefaultTimeout(30000);
  let page = opener;

  try {
    logger.step(`에디터 열기: ${post.title}`, { jobId });
    const opened = await openWriteEditor(page, blogId, jobId);
    const scope = opened.scope;
    page = opened.page;        // 새 창으로 열렸으면 그쪽을 쓴다.

    await dismissPopups(scope);

    const { locator: titleField } = await findFirst(scope, SELECTORS.title, 15000);
    await typeInto(page, titleField, post.title);
    logger.info('제목 입력 완료', { jobId });

    const { locator: bodyField } = await findFirst(scope, SELECTORS.body, 15000);
    await bodyField.click({ timeout: 10000 });
    await page.waitForTimeout(200);

    const introMode = await pasteHtml(page, scope, buildIntroHtml(post));
    logger.info(`도입부 입력 완료 (${introMode})`, { jobId });

    if (thumbnailPath) {
      await insertImage(page, scope, thumbnailPath);
      logger.info('썸네일 삽입 완료 (도입부 직후)', { jobId });
    }

    // 표가 큰 글은 한 번에 밀어 넣으면 에디터가 버거워한다. 블록 단위로 나눠 붙인다.
    // 각 블록 앞에 빈 문단을 붙이는 게 핵심이다. 그게 없으면 블록의 첫 문단이
    // 커서가 있던 문단 뒤에 그대로 이어붙어 "구조였습니다.• • •소제목" 처럼 나온다.
    const blocks = buildBodyBlocks(post);
    let lastMode = '';
    for (let index = 0; index < blocks.length; index += 1) {
      lastMode = await pasteHtml(page, scope, BLOCK_GAP + blocks[index]);
      if (blocks.length > 3) {
        logger.info(`본문 ${index + 1}/${blocks.length} 블록 입력 (${lastMode})`, { jobId });
      }
      await page.waitForTimeout(250);
    }
    logger.info(`본문 입력 완료 (${blocks.length}개 블록, ${lastMode})`, { jobId });

    const confirmed = await saveDraft(page, scope);
    return { saved: true, confirmed, blogId };
  } catch (error) {
    const shot = await captureFailure(page, jobId);
    error.screenshot = shot;
    throw error;
  } finally {
    await page.waitForTimeout(800).catch(() => {});
    // 글쓰기가 새 창으로 열렸다면 처음 열었던 창도 같이 닫는다.
    await page.close().catch(() => {});
    if (opener !== page) await opener.close().catch(() => {});
  }
}
