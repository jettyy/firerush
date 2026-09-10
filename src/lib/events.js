import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

const RING_SIZE = 400;
const ring = [];

/** 대시보드 로그 콘솔로 흘려보내는 한 줄. */
export function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  const tag = level.toUpperCase().padEnd(5);
  console.log(`[${tag}] ${message}`);
  bus.emit('event', { type: 'log', payload: entry });
  return entry;
}

export const logger = {
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
  step: (m, meta) => log('step', m, meta),
};

/** 상태 변화(작업 목록, 로그인 상태 등)를 SSE 로 밀어준다. */
export function push(type, payload) {
  bus.emit('event', { type, payload });
}

export function recentLogs() {
  return ring.slice(-120);
}
