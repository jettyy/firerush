import { ensureBrowsers } from '../src/lib/playwright.js';
import { checkClaude } from '../src/ai/claude.js';

console.log('파이어러시 준비 상태를 확인합니다.\n');

const claude = await checkClaude();
console.log(claude.ok
  ? `✅ claude CLI: ${claude.version}`
  : `❌ claude CLI: ${claude.message}\n   → npm install -g @anthropic-ai/claude-code 로 설치한 뒤 'claude' 를 한 번 실행해 로그인하세요.`);

try {
  await ensureBrowsers();
  console.log('✅ Playwright 크로미움 준비 완료');
} catch (error) {
  console.log(`❌ 크로미움 준비 실패: ${error.message}`);
}

console.log('\n준비가 끝났으면 npm start 로 대시보드를 실행하세요.');
