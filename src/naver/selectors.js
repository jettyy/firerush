/**
 * 네이버 스마트에디터 ONE 은 클래스 이름에 해시가 붙어 수시로 바뀐다.
 * 그래서 후보를 여러 개 두고 먼저 잡히는 것을 쓴다.
 * 자동화가 깨지면 대부분 여기만 손보면 된다.
 */
export const SELECTORS = {
  // 에디터가 떴는지 확인
  editorReady: [
    '.se-content',
    '.se-main-container',
    '.se-documentTitle',
  ],

  // 제목 입력 영역
  title: [
    '.se-documentTitle .se-text-paragraph',
    '.se-section-documentTitle .se-text-paragraph',
    '.se-documentTitle',
  ],

  // 본문 입력 영역 (첫 문단)
  body: [
    '.se-component.se-text:not(.se-documentTitle) .se-text-paragraph',
    '.se-main-container .se-text-paragraph',
    '.se-content .se-text-paragraph',
  ],

  // 사진 첨부 버튼
  imageButton: [
    'button.se-image-toolbar-button',
    '.se-toolbar button[data-name="image"]',
    'button[data-log="ect.image"]',
    'button[title="사진"]',
  ],

  // 임시저장 버튼 (발행 버튼과 헷갈리지 않도록 텍스트가 정확히 "저장"인 것)
  saveButton: [
    'button.save_btn__bzc5B',
    '.header button:text-is("저장")',
    'button[data-click-area="tpb.save"]',
    'button:text-is("저장")',
  ],

  // 저장 완료 표시
  saveToast: [
    '.se-toast-content:has-text("저장")',
    'text=저장되었습니다',
    '.text__A_hKf',
  ],

  // "작성 중인 글이 있습니다" 팝업 - 새로 쓰기 위해 취소를 누른다
  draftPopupCancel: [
    '.se-popup-button-cancel',
    '.se-popup-button:text-is("취소")',
    'button.se-popup-button-cancel',
  ],

  // 처음 진입 시 뜨는 도움말 패널 닫기
  helpPanelClose: [
    '.se-help-panel-close-button',
    'button.se-help-panel-close-button',
    '.se-guide-close-button',
  ],
};

/** 후보들 중 실제로 보이는 첫 요소를 찾는다. */
export async function findFirst(scope, candidates, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      try {
        const locator = scope.locator(selector).first();
        if (await locator.isVisible({ timeout: 300 })) return { locator, selector };
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `요소를 찾지 못했습니다: ${candidates[0]} 외 ${candidates.length - 1}개 후보` +
    (lastError ? ` (${lastError.message.split('\n')[0]})` : ''),
  );
}

/** 있으면 누르고, 없으면 조용히 넘어간다. (팝업처럼 뜰 수도 안 뜰 수도 있는 것) */
export async function clickIfPresent(scope, candidates, timeout = 2500) {
  try {
    const { locator, selector } = await findFirst(scope, candidates, timeout);
    await locator.click({ timeout: 2000 });
    return selector;
  } catch {
    return null;
  }
}
