import { spawn } from 'node:child_process';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';

/**
 * 응답 봉투에서 실제로 글을 쓴 모델을 뽑아낸다.
 * claude CLI 는 modelUsage 에 { "claude-sonnet-5": {...} } 형태로 알려준다.
 */
function pickModel(envelope) {
  const usage = envelope?.modelUsage;
  if (!usage || typeof usage !== 'object') return '';
  const entries = Object.entries(usage);
  if (!entries.length) return '';
  // 여러 모델이 섞였다면 출력 토큰이 가장 많은 쪽이 본문을 쓴 모델이다.
  entries.sort((a, b) => (b[1]?.outputTokens || 0) - (a[1]?.outputTokens || 0));
  const [id, info] = entries[0];
  return info?.canonicalModel || id;
}

/**
 * Claude Code CLI 를 -p(print) 모드로 호출한다.
 * API 키 종량제가 아니라 CLI 에 이미 로그인된 구독 계정을 그대로 쓰기 때문에
 * 글을 100개 뽑아도 토큰 요금이 따로 붙지 않는다.
 *
 * @returns {Promise<{text: string, model: string, costUsd: number, durationMs: number}>}
 */
export function runClaude(prompt, { systemPrompt = '', timeoutMs, signal, model } = {}) {
  const settings = getSettings();
  const command = settings.claude.command || 'claude';
  const limit = timeoutMs || settings.claude.timeoutMs || 300000;
  const wanted = model ?? settings.claude.model;

  const args = [
    '-p',
    '--output-format', 'json',
    '--restricted',            // 글쓰기에는 Bash/코드 실행 도구가 필요 없다.
    '--no-session-persistence',
    '--strict-mcp-config',
  ];
  if (wanted) args.push('--model', wanted);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (error) {
      reject(new Error(`claude CLI 를 실행하지 못했습니다: ${error.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude 응답이 ${Math.round(limit / 1000)}초 안에 오지 않았습니다.`));
    }, limit);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('사용자가 중지했습니다.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error.code === 'ENOENT') {
        reject(new Error(
          `claude CLI 를 찾을 수 없습니다. 'npm install -g @anthropic-ai/claude-code' 로 설치하고 ` +
          `'claude' 로 한 번 로그인한 뒤 다시 시도하세요. (설정의 claude.command 로 경로 지정 가능)`
        ));
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      if (code !== 0) {
        const detail = stderr.trim().slice(0, 500) || '(stderr 없음)';
        const hint = wanted && /model/i.test(detail)
          ? ` — '${wanted}' 모델을 쓸 수 없는 플랜일 수 있습니다. 설정에서 다른 모델을 골라보세요.`
          : '';
        reject(new Error(`claude CLI 종료 코드 ${code}: ${detail}${hint}`));
        return;
      }

      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          reject(new Error(`claude 오류: ${envelope.result || envelope.subtype}`));
          return;
        }
        resolve({
          text: String(envelope.result ?? ''),
          model: pickModel(envelope) || wanted || '',
          costUsd: Number(envelope.total_cost_usd) || 0,
          durationMs: Number(envelope.duration_ms) || 0,
        });
      } catch {
        // --output-format json 이 아닌 형태로 나온 경우 원문을 그대로 쓴다.
        resolve({ text: stdout.trim(), model: wanted || '', costUsd: 0, durationMs: 0 });
      }
    });

    child.stdin.end(prompt, 'utf8');
  });
}

/** 모델이 앞뒤로 말을 덧붙였어도 JSON 본체만 뽑아낸다. */
export function extractJson(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // 첫 '{' 부터 마지막 '}' 까지 잘라 한 번 더 시도.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (error) {
        throw new Error(`AI 응답을 JSON 으로 읽지 못했습니다: ${error.message}`);
      }
    }
    throw new Error('AI 응답에서 JSON 을 찾지 못했습니다.');
  }
}

/**
 * JSON 응답을 요구하는 호출. 한 번 실패하면 형식을 다시 일러주고 재시도한다.
 * @returns {Promise<{data: any, model: string, costUsd: number}>}
 */
export async function runClaudeJson(prompt, options = {}) {
  try {
    const reply = await runClaude(prompt, options);
    return { data: extractJson(reply.text), model: reply.model, costUsd: reply.costUsd };
  } catch (error) {
    logger.warn(`AI 응답 파싱 실패, 형식을 다시 지정해 재시도합니다. (${error.message})`);
    const retryPrompt =
      `${prompt}\n\n` +
      `[중요] 설명이나 인사말 없이 JSON 객체 하나만 출력하세요. ` +
      `코드 펜스(\`\`\`)도 쓰지 말고 '{' 로 시작해서 '}' 로 끝나야 합니다.`;
    const reply = await runClaude(retryPrompt, options);
    return { data: extractJson(reply.text), model: reply.model, costUsd: reply.costUsd };
  }
}

/** CLI 가 설치·로그인되어 있는지 확인. */
export async function checkClaude() {
  const settings = getSettings();
  const command = settings.claude.command || 'claude';
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve({ ok: false, version: '', message: 'claude CLI 를 찾을 수 없습니다.' }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, version: out.trim(), message: '' });
      else resolve({ ok: false, version: '', message: `claude --version 종료 코드 ${code}` });
    });
  });
}
