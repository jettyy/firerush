const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  pending: '대기',
  writing: '글 작성 중',
  thumbnail: '썸네일 생성',
  posting: '네이버 저장 중',
  done: '완료',
  failed: '실패',
  skipped: '건너뜀',
};

let state = { settings: null, session: null, jobs: [], runner: null };

/* ---------- 공통 ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, message: '응답을 읽지 못했습니다.' }));
  if (!res.ok || data.ok === false) throw new Error(data.message || `요청 실패 (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ---------- 렌더 ---------- */

function renderPills(health) {
  const claude = $('pill-claude');
  const browser = $('pill-browser');
  if (health) {
    claude.textContent = health.claude.ok ? `AI 준비됨 · ${health.claude.version.split(' ')[0]}` : 'claude CLI 없음';
    claude.className = `pill ${health.claude.ok ? 'ok' : 'bad'}`;
    browser.textContent = health.browser.ok ? '브라우저 준비됨' : '브라우저 준비 실패';
    browser.className = `pill ${health.browser.ok ? 'ok' : 'bad'}`;
  }
  renderSession();
}

function renderSession() {
  const pill = $('pill-session');
  const session = state.session || {};
  if (session.loggedIn) {
    pill.textContent = `네이버 로그인됨${session.blogId ? ` · ${session.blogId}` : ''}`;
    pill.className = 'pill ok';
    $('login-detail').textContent = session.checkedAt
      ? `마지막 확인: ${new Date(session.checkedAt).toLocaleString('ko-KR')}`
      : '세션이 저장되어 있습니다.';
  } else {
    pill.textContent = '네이버 로그인 필요';
    pill.className = 'pill bad';
    $('login-detail').textContent = '세션은 이 컴퓨터에만 저장됩니다.';
  }
}

function renderJobs() {
  const body = $('job-body');
  const jobs = state.jobs || [];
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">아직 추가된 주제가 없습니다.</td></tr>';
    return;
  }
  const current = state.runner?.currentJobId;
  body.innerHTML = jobs
    .map((job, index) => {
      const label = STATUS_LABEL[job.status] || job.status;
      const thumb = job.thumbnailPath
        ? `<a href="/thumbnails/${encodeURIComponent(job.thumbnailPath)}" target="_blank" rel="noopener">
             <img src="/thumbnails/${encodeURIComponent(job.thumbnailPath)}" alt="썸네일"></a>`
        : '<span class="hint">-</span>';
      return `<tr class="${job.id === current ? 'active' : ''}">
        <td>${index + 1}</td>
        <td class="topic">${escapeHtml(job.topic)}</td>
        <td><span class="badge ${job.status}">${label}</span></td>
        <td class="msg">${job.title ? `<b>${escapeHtml(job.title)}</b>` : ''}${escapeHtml(job.message || '')}</td>
        <td>${job.charCount || '-'}</td>
        <td class="thumb-cell">${thumb}</td>
        <td>
          <button class="btn ghost small" data-retry="${job.id}">재시도</button>
          <button class="btn ghost small danger" data-remove="${job.id}">삭제</button>
        </td>
      </tr>`;
    })
    .join('');
}

function renderRunner() {
  const runner = state.runner;
  if (!runner) return;
  const { total, done, failed, pending, running } = runner.stats;
  const finished = done + failed;
  $('progress-bar').style.width = total ? `${Math.round((finished / total) * 100)}%` : '0%';

  let text = `전체 ${total} · 완료 ${done} · 실패 ${failed} · 대기 ${pending}`;
  if (runner.running) text += runner.paused ? ' · 일시정지' : ' · 실행 중';
  if (runner.waitUntil) {
    const left = Math.max(0, Math.round((runner.waitUntil - Date.now()) / 1000));
    text += ` · 다음 글까지 ${left}초`;
  }
  $('run-stats').textContent = text;

  $('btn-start').disabled = runner.running || pending === 0;
  $('btn-pause').disabled = !runner.running;
  $('btn-pause').textContent = runner.paused ? '이어서 실행' : '일시정지';
  $('btn-stop').disabled = !runner.running;
  void running;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('blog-id').value = s.blogId || '';
  $('s-tone').value = s.post.tone;
  $('s-chars').value = s.post.targetChars;
  $('s-sections').value = s.post.sectionCount;
  $('s-audience').value = s.post.audience;
  $('s-guideline').value = s.post.extraGuideline || '';
  $('s-thumb-style').value = s.thumbnail.style;
  $('s-thumb-w').value = s.thumbnail.width;
  $('s-thumb-h').value = s.thumbnail.height;
  $('s-delay-min').value = s.run.delayMinSec;
  $('s-delay-max').value = s.run.delayMaxSec;
  $('s-retries').value = s.run.maxRetries;
  $('s-model').value = s.claude.model || '';
  $('s-headless').checked = Boolean(s.run.headless);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function appendLog(entry) {
  const box = $('console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = 'line';
  const time = new Date(entry.ts).toLocaleTimeString('ko-KR', { hour12: false });
  line.innerHTML = `<span class="ts">${time}</span><span class="${entry.level}">${escapeHtml(entry.message)}</span>`;
  box.appendChild(line);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- 이벤트 스트림 ---------- */

function connectStream() {
  const source = new EventSource('/api/stream');
  source.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);
    if (type === 'log') appendLog(payload);
    else if (type === 'jobs') { state.jobs = payload; renderJobs(); }
    else if (type === 'job') {
      const index = state.jobs.findIndex((job) => job.id === payload.id);
      if (index >= 0) state.jobs[index] = payload; else state.jobs.push(payload);
      renderJobs();
    } else if (type === 'runner') { state.runner = payload; renderRunner(); renderJobs(); }
    else if (type === 'session') { state.session = payload; renderSession(); refreshState(); }
  };
  source.onerror = () => { /* EventSource 가 알아서 재접속한다. */ };
}

/* ---------- 초기화 ---------- */

async function refreshState() {
  const data = await api('/api/state');
  state = { ...state, settings: data.settings, session: data.session, jobs: data.jobs, runner: data.runner };
  renderSettings();
  renderSession();
  renderJobs();
  renderRunner();
  return data;
}

async function boot() {
  const data = await refreshState();
  $('console').innerHTML = '';
  (data.logs || []).forEach(appendLog);
  connectStream();
  api('/api/health').then(renderPills).catch(() => {});
  setInterval(renderRunner, 1000);
}

/* ---------- 버튼 ---------- */

$('btn-login').onclick = async () => {
  await api('/api/login', { method: 'POST' });
  toast('로그인 창을 띄웠습니다. 창에서 직접 로그인해 주세요.');
};

$('btn-verify').onclick = async () => {
  toast('세션을 확인하는 중...');
  const data = await api('/api/login/verify', { method: 'POST' });
  state.session = data.session;
  renderSession();
  toast(data.session.loggedIn ? '로그인 세션이 유효합니다.' : '로그인이 필요합니다.');
};

$('btn-logout').onclick = async () => {
  if (!confirm('저장된 네이버 세션을 삭제할까요?')) return;
  await api('/api/logout', { method: 'POST' });
  await refreshState();
  toast('세션을 삭제했습니다.');
};

let previewTimer = null;
$('topics').addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const data = await api('/api/topics/preview', { method: 'POST', body: { raw: $('topics').value } });
    $('paste-count').textContent = `${data.count}개 인식`;
  }, 250);
});

$('btn-add').onclick = async () => {
  const raw = $('topics').value;
  if (!raw.trim()) return toast('먼저 주제를 붙여넣어 주세요.');
  const data = await api('/api/topics', { method: 'POST', body: { raw } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
  $('topics').value = '';
  $('paste-count').textContent = '0개 인식';
  toast(`${data.added}건 추가${data.skipped ? ` (중복 ${data.skipped}건 제외)` : ''}`);
};

$('btn-clear-text').onclick = () => {
  $('topics').value = '';
  $('paste-count').textContent = '0개 인식';
};

$('btn-toggle-settings').onclick = () => {
  const panel = $('settings');
  panel.classList.toggle('hidden');
  $('btn-toggle-settings').textContent = panel.classList.contains('hidden') ? '펼치기' : '접기';
};

function collectSettings() {
  return {
    blogId: $('blog-id').value.trim(),
    claude: { model: $('s-model').value.trim() },
    post: {
      tone: $('s-tone').value,
      targetChars: Number($('s-chars').value),
      sectionCount: Number($('s-sections').value),
      audience: $('s-audience').value,
      extraGuideline: $('s-guideline').value,
    },
    thumbnail: {
      style: $('s-thumb-style').value,
      width: Number($('s-thumb-w').value),
      height: Number($('s-thumb-h').value),
    },
    run: {
      delayMinSec: Number($('s-delay-min').value),
      delayMaxSec: Number($('s-delay-max').value),
      maxRetries: Number($('s-retries').value),
      headless: $('s-headless').checked,
    },
  };
}

$('btn-save-settings').onclick = async () => {
  const data = await api('/api/settings', { method: 'POST', body: collectSettings() });
  state.settings = data.settings;
  toast('설정을 저장했습니다.');
};

$('blog-id').addEventListener('change', async () => {
  await api('/api/settings', { method: 'POST', body: { blogId: $('blog-id').value.trim() } });
  toast('블로그 아이디를 저장했습니다.');
});

$('btn-preview-thumb').onclick = () => {
  const params = new URLSearchParams({
    headline: '겨울철 실내 습도 관리법',
    subline: '가습기 없이도 40~60% 유지하는 방법',
    badge: '생활 정리',
    emoji: '💧',
    accent: '#16324F',
    style: $('s-thumb-style').value,
  });
  const frame = $('thumb-preview');
  frame.src = `/api/thumbnail/preview?${params}`;
  frame.classList.remove('hidden');
};

$('btn-start').onclick = async () => {
  try {
    await api('/api/run/start', { method: 'POST' });
    toast('실행을 시작했습니다.');
  } catch (error) { toast(error.message); }
};
$('btn-pause').onclick = () => api('/api/run/pause', { method: 'POST' }).catch((e) => toast(e.message));
$('btn-stop').onclick = () => api('/api/run/stop', { method: 'POST' }).catch((e) => toast(e.message));

$('btn-clear-done').onclick = async () => {
  const data = await api('/api/jobs/clear', { method: 'POST', body: { onlyFinished: true } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
};

$('btn-clear-all').onclick = async () => {
  if (!confirm('작업 목록을 모두 비울까요?')) return;
  const data = await api('/api/jobs/clear', { method: 'POST', body: { onlyFinished: false } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
};

$('btn-clear-log').onclick = () => { $('console').innerHTML = ''; };

$('job-body').addEventListener('click', async (event) => {
  const retry = event.target.dataset.retry;
  const remove = event.target.dataset.remove;
  if (retry) { await api(`/api/jobs/${retry}/retry`, { method: 'POST' }); await refreshState(); }
  if (remove) { await api(`/api/jobs/${remove}`, { method: 'DELETE' }); await refreshState(); }
});

boot().catch((error) => toast(error.message));
