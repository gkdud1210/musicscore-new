/**
 * API 통신 모듈
 * ScoreShift AI 악보 조 변환기
 */

const API_BASE = window.location.origin;

/**
 * 서버 상태 확인
 */
async function checkServerStatus() {
  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (!dot || !text) return;
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      dot.className  = 'status-dot online';
      text.textContent = '서버 연결됨';
    } else throw new Error('unhealthy');
  } catch {
    dot.className  = 'status-dot offline';
    text.textContent = '서버 오프라인 (데모 모드)';
  }
}

/**
 * 악보 이미지 분석 요청
 * @param {File} file - 업로드된 이미지 파일
 * @returns {Object} 분석 결과
 */
async function apiAnalyzeScore(file) {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('API unavailable, using demo data:', e.message);
    return getDemoAnalysisData();
  }
}

/**
 * 조 변환 요청
 * @param {Object} analysisData - 분석 결과 (notes, key 등)
 * @param {string} targetKey    - 변환 목표 조성
 * @param {number} semitones    - 반음 수
 * @param {Object} options      - 변환 옵션
 * @returns {Object} 변환 결과
 */
async function apiTransposeScore(analysisData, targetKey, semitones, options = {}) {
  try {
    const res = await fetch(`${API_BASE}/transpose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: analysisData.notes,
        original_key: analysisData.key,
        target_key: targetKey,
        semitones: semitones,
        time_signature: analysisData.time_signature,
        ...options
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('API unavailable, transposing locally:', e.message);
    return localTranspose(analysisData, semitones, targetKey, options);
  }
}

/* ============================================================
   로컬 음악 처리 (백엔드 없을 때 폴백)
   ============================================================ */

const ALL_NOTES     = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NOTES    = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const KEY_SIGNATURES = {
  major: {
    'C':  { sharps: 0, flats: 0 },
    'G':  { sharps: 1, flats: 0 },
    'D':  { sharps: 2, flats: 0 },
    'A':  { sharps: 3, flats: 0 },
    'E':  { sharps: 4, flats: 0 },
    'B':  { sharps: 5, flats: 0 },
    'F#': { sharps: 6, flats: 0 },
    'C#': { sharps: 7, flats: 0 },
    'F':  { sharps: 0, flats: 1 },
    'Bb': { sharps: 0, flats: 2 },
    'Eb': { sharps: 0, flats: 3 },
    'Ab': { sharps: 0, flats: 4 },
    'Db': { sharps: 0, flats: 5 },
    'Gb': { sharps: 0, flats: 6 },
    'Cb': { sharps: 0, flats: 7 },
  },
  minor: {
    'A':  { sharps: 0, flats: 0 },
    'E':  { sharps: 1, flats: 0 },
    'B':  { sharps: 2, flats: 0 },
    'F#': { sharps: 3, flats: 0 },
    'C#': { sharps: 4, flats: 0 },
    'G#': { sharps: 5, flats: 0 },
    'D#': { sharps: 6, flats: 0 },
    'A#': { sharps: 7, flats: 0 },
    'D':  { sharps: 0, flats: 1 },
    'G':  { sharps: 0, flats: 2 },
    'C':  { sharps: 0, flats: 3 },
    'F':  { sharps: 0, flats: 4 },
    'Bb': { sharps: 0, flats: 5 },
    'Eb': { sharps: 0, flats: 6 },
    'Ab': { sharps: 0, flats: 7 },
  }
};

/**
 * 로컬 조 변환
 */
function localTranspose(analysisData, semitones, targetKey, options = {}) {
  const useFlats = options.use_flats || false;
  const noteArr = useFlats ? FLAT_NOTES : ALL_NOTES;

  const transposedNotes = analysisData.notes.map(note => {
    if (note.type === 'rest') return { ...note };

    const pitchClean = note.pitch.replace('b', '').replace('#', '');
    const isSharp = note.pitch.includes('#');
    const isFlat  = note.pitch.includes('b') && note.pitch.length > 1;

    let pitchForSearch = note.pitch;
    if (isFlat) {
      const flatIdx = FLAT_NOTES.indexOf(note.pitch);
      if (flatIdx >= 0) pitchForSearch = ALL_NOTES[flatIdx];
    }

    const originalIdx = ALL_NOTES.indexOf(pitchForSearch);
    if (originalIdx === -1) return { ...note };

    let newIdx = ((originalIdx + semitones) % 12 + 12) % 12;
    let newOctave = note.octave || 4;

    // 옥타브 조정
    const totalSemitones = (note.octave || 4) * 12 + originalIdx + semitones;
    newOctave = Math.floor(totalSemitones / 12);
    newIdx = ((totalSemitones % 12) + 12) % 12;

    const newPitch = noteArr[newIdx];
    return {
      ...note,
      pitch: newPitch,
      octave: newOctave,
      original_pitch: note.pitch,
      original_octave: note.octave,
    };
  });

  return {
    success: true,
    original_key: analysisData.key,
    target_key: targetKey,
    semitones: semitones,
    notes: transposedNotes,
    time_signature: analysisData.time_signature,
    tempo: analysisData.tempo,
  };
}

/**
 * 두 조성 간 반음 거리 계산
 */
function calculateSemitones(fromKey, toKey) {
  const noteOrder = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const flatMap = { 'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#', 'Cb': 'B' };

  const normalize = k => {
    const root = k.replace(' Major', '').replace(' Minor', '').replace(' major', '').replace(' minor', '').trim();
    return flatMap[root] || root;
  };

  const fromIdx = noteOrder.indexOf(normalize(fromKey));
  const toIdx   = noteOrder.indexOf(normalize(toKey));
  if (fromIdx === -1 || toIdx === -1) return 0;

  let diff = toIdx - fromIdx;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
}

/**
 * 서명 문자 생성 (♯ × n 또는 ♭ × n)
 */
function getKeyAccidentalDisplay(keyRoot, mode = 'major') {
  const modeMap = mode === 'major' ? KEY_SIGNATURES.major : KEY_SIGNATURES.minor;
  const info = modeMap[keyRoot] || { sharps: 0, flats: 0 };
  if (info.sharps > 0) return '♯'.repeat(info.sharps);
  if (info.flats  > 0) return '♭'.repeat(info.flats);
  return '없음';
}

/* ============================================================
   데모 데이터 (백엔드 없을 때)
   ============================================================ */
function getDemoAnalysisData() {
  return {
    success: true,
    key: 'C',
    scale: 'Major',
    key_display: 'C Major',
    time_signature: '4/4',
    tempo: 120,
    clef: 'treble',
    notes: [
      { pitch: 'C', octave: 4, duration: 'q', measure: 1, beat: 1 },
      { pitch: 'E', octave: 4, duration: 'q', measure: 1, beat: 2 },
      { pitch: 'G', octave: 4, duration: 'q', measure: 1, beat: 3 },
      { pitch: 'C', octave: 5, duration: 'q', measure: 1, beat: 4 },
      { pitch: 'D', octave: 5, duration: 'h', measure: 2, beat: 1 },
      { pitch: 'B', octave: 4, duration: 'q', measure: 2, beat: 3 },
      { pitch: 'G', octave: 4, duration: 'q', measure: 2, beat: 4 },
      { pitch: 'A', octave: 4, duration: 'q', measure: 3, beat: 1 },
      { pitch: 'F', octave: 4, duration: 'q', measure: 3, beat: 2 },
      { pitch: 'G', octave: 4, duration: 'h', measure: 3, beat: 3 },
      { pitch: 'E', octave: 4, duration: 'q', measure: 4, beat: 1 },
      { pitch: 'D', octave: 4, duration: 'q', measure: 4, beat: 2 },
      { pitch: 'C', octave: 4, duration: 'h', measure: 4, beat: 3 },
    ],
    raw_analysis: '🎵 데모 모드: 실제 AI 분석을 사용하려면 백엔드 서버를 실행하세요.\n\n백엔드를 시작하려면:\n  cd backend && pip install -r requirements.txt\n  python app.py\n\n그 후 OpenAI API 키를 .env 파일에 설정하세요:\n  OPENAI_API_KEY=your_api_key_here',
    confidence: 0.95,
  };
}

// 서버 상태 확인 (페이지 로드 후)
window.addEventListener('load', () => {
  setTimeout(checkServerStatus, 500);
  setInterval(checkServerStatus, 30000);
});

/* ============================================================
   공용 유틸 (라이브러리 / 뷰어 페이지에서 공유)
   ============================================================ */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

/* ============================================================
   로그인 상태 / 권한 (공용 비밀번호)
   ============================================================ */
const AuthState = { auth: false, role: 'admin', canEdit: true, hasAdmin: false, server: 'python', ready: null };

// 로그인이 풀린 상태에서 API를 부르면 로그인 화면으로 보낸다
(function wrapFetchForAuth() {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await origFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);
    if (sameOrigin && res.status === 401 && !url.includes('/api/login') && !location.pathname.endsWith('login.html')) {
      const next = location.pathname + location.search;
      location.href = `login.html?next=${encodeURIComponent(next)}`;
    }
    return res;
  };
})();

AuthState.ready = (async () => {
  try {
    const res = await fetch(`${API_BASE}/api/me`);
    if (res.ok) {
      const me = await res.json();
      AuthState.auth = me.auth;
      AuthState.role = me.role;
      AuthState.name = me.name || '';
      AuthState.canEdit = !!me.can_edit;
      AuthState.hasAdmin = !!me.has_admin;
      AuthState.server = me.server || 'python';
    }
  } catch { /* 오프라인이면 기본값(로컬 사용) */ }
  return AuthState;
})();

window.addEventListener('DOMContentLoaded', async () => {
  await AuthState.ready;
  document.body.classList.toggle('read-only', !AuthState.canEdit);
  // 카페24(PHP) 서버에는 조 변환(파이썬 전용)이 없다
  if (AuthState.server === 'php') {
    document.querySelectorAll('a[href="transpose.html"], #analyzePageBtn').forEach(el => { el.style.display = 'none'; });
  }
  // 새 콘티를 라이브러리에 저장하기는 카페24 서버에만 있다
  if (AuthState.server !== 'php') document.getElementById('setlistSaveBtn')?.remove();
  renderHeaderAccount();
  showInstallGuideOnce();
  startPresence();
});

/* ============================================================
   접속자 수 — 화면이 열려 있는 동안 1분마다 "여기 있어요" 신호,
   관리자에게는 위에 "👀 지금 N명" (누르면 오늘·최근 7일)
   ============================================================ */
function presenceId() {
  try {
    let id = localStorage.getItem('jandi_vid');
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('jandi_vid', id);
    }
    return id;
  } catch { return ''; }   // 개인정보 보호 모드 등 — 서버가 IP로 대신 셈
}

function startPresence() {
  if (AuthState.server !== 'php' || (AuthState.auth && !AuthState.role)) return;
  const vid = presenceId();
  const ping = () => {
    if (document.visibilityState !== 'visible') return;
    fetch(`${API_BASE}/api/ping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vid }),
    }).catch(() => {});
  };
  ping();
  setInterval(ping, 60000);
  document.addEventListener('visibilitychange', ping);
  if (AuthState.canEdit && AuthState.hasAdmin) initVisitorBadge();
}

function initVisitorBadge() {
  const box = document.getElementById('headerAccount');
  if (!box) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'header-account-btn visitor-badge';
  btn.textContent = '👀 …';
  btn.title = '지금 접속 중인 사람 (누르면 오늘·최근 7일)';
  box.prepend(btn);
  const panel = document.createElement('div');
  panel.className = 'visitor-panel hidden';
  document.body.appendChild(panel);
  let last = null;
  const draw = () => {
    if (!last) return;
    const max = Math.max(1, ...last.days.map(d => d.count));
    const wd = ['일', '월', '화', '수', '목', '금', '토'];
    panel.innerHTML = `
      <div class="visitor-panel-head">
        <b>지금 ${last.now}명</b>
        <span>관리자 ${last.now_admin} · 팀원 ${last.now_member}</span>
      </div>
      <div class="visitor-panel-today">오늘 들어온 기기 <b>${last.today}대</b></div>
      <div class="visitor-days">${last.days.map(d => {
        const dt = new Date(d.day + 'T00:00:00');
        return `<div class="visitor-day"><span class="visitor-bar" style="height:${Math.max(2, Math.round(d.count / max * 56))}px"></span>
          <b>${d.count}</b><small>${dt.getMonth() + 1}/${dt.getDate()} ${wd[dt.getDay()]}</small></div>`;
      }).join('')}</div>
      <p class="visitor-note">같은 기기는 하루 한 번만 세요. "지금"은 최근 2~3분 안에 화면을 보고 있던 기기예요.</p>
      <button type="button" class="btn-sm visitor-people-btn" data-people-open>👥 사람별 입장코드 관리</button>`;
  };
  panel.addEventListener('click', e => {
    if (e.target.closest('[data-people-open]')) { panel.classList.add('hidden'); openPeopleEditor(); }
  });
  const load = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/visitors`);
      if (!res.ok) return;
      last = await res.json();
      btn.innerHTML = `👀 <span class="vb-long">지금 </span>${last.now}<span class="vb-long">명</span>`;
      draw();
    } catch { /* 다음에 다시 */ }
  };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 8}px`;
    panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) load();
  });
  document.addEventListener('click', e => { if (!panel.contains(e.target)) panel.classList.add('hidden'); });
  setTimeout(load, 1500);   // 내 첫 신호가 먼저 들어가게
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
}

/* ── 밝은 화면 / 어두운 화면 (기기마다 기억) ── */
function currentTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
function setTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('jandi.theme', theme); } catch { /* 저장 불가 */ }
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#0a0a0f');
  document.querySelectorAll('.theme-toggle-btn').forEach(paintThemeBtn);
}
function paintThemeBtn(btn) {
  const light = currentTheme() === 'light';
  btn.textContent = light ? '🌙' : '☀️';
  btn.title = light ? '어두운 화면으로' : '밝은 화면으로';
  btn.setAttribute('aria-label', btn.title);
}
function initThemeToggle(btn) {
  if (!btn) return;
  paintThemeBtn(btn);
  btn.addEventListener('click', () => setTheme(currentTheme() === 'light' ? 'dark' : 'light'));
}

/* ── 사람별 입장코드 (관리자) — 그 코드로 들어오면 라이브 메세지에 이름이 붙어요 ── */
async function peopleApi(method, data) {
  const res = await fetch(`${API_BASE}/api/people`, data
    ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : { method });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.detail || `HTTP ${res.status}`);
  return j;
}

async function openPeopleEditor() {
  document.getElementById('peopleEditor')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'peopleEditor';
  wrap.className = 'people-editor';
  wrap.innerHTML = '<div class="people-box"><p>불러오는 중...</p></div>';
  document.body.appendChild(wrap);
  let people = [], teamCode = '';
  try { const r = await peopleApi('GET'); people = r.people || []; teamCode = r.team_code || ''; }
  catch (e) { wrap.remove(); showToast('불러오기 실패: ' + e.message, 'error'); return; }
  const row = p => `<div class="people-row" data-id="${escapeHtml(p.id || '')}">
      <input type="text" class="lib-edit-title-input people-name" maxlength="20" placeholder="이름 (예: 베이스 하늘)" value="${escapeHtml(p.name || '')}" />
      <input type="text" class="lib-edit-title-input people-code" maxlength="30" inputmode="numeric" placeholder="입장코드" value="${escapeHtml(p.code || '')}" />
      <label class="people-mute" title="라이브 메세지 받는 사람에서 처음부터 빠져 있어요 (보낼 때 눌러서 넣을 수 있어요)">
        <input type="checkbox" class="people-mute-cb"${p.mute ? ' checked' : ''} /> 메세지 기본 제외</label>
      <button type="button" class="btn-sm" data-people="del" aria-label="빼기">✕</button>
    </div>`;
  wrap.innerHTML = `<div class="people-box" role="dialog" aria-modal="true" aria-label="사람별 입장코드">
    <h3>👥 사람별 입장코드</h3>
    <p class="people-sub">이 코드로 들어온 사람은 라이브에서 💬 메세지를 보낼 수 있고, 보낸 사람 이름이 같이 떠요.
      관리자 코드는 따로 그대로예요. 코드를 지우면 그 사람은 다시 로그인해야 해요.</p>
    <label class="people-team">팀 공용 코드 <small>(이름 없이 들어오는 코드 · 메세지엔 "팀원"으로 떠요)</small>
      <input type="text" class="lib-edit-title-input people-code" id="peopleTeamCode" maxlength="30" inputmode="numeric" value="${escapeHtml(teamCode)}" /></label>
    <div class="people-list" id="peopleList">${(people.length ? people : [{}]).map(row).join('')}</div>
    <div class="people-actions">
      <button type="button" class="btn-sm" data-people="add">＋ 사람 추가</button>
      <span style="flex:1"></span>
      <button type="button" class="btn-sm" data-people="close">닫기</button>
      <button type="button" class="btn-primary btn-compact" data-people="save">저장</button>
    </div>
  </div>`;
  wrap.addEventListener('click', async e => {
    const b = e.target.closest('[data-people]');
    if (!b) { if (e.target === wrap) wrap.remove(); return; }
    const act = b.dataset.people;
    if (act === 'del') b.closest('.people-row').remove();
    if (act === 'add') {
      document.getElementById('peopleList').insertAdjacentHTML('beforeend', row({}));
      document.querySelector('#peopleList .people-row:last-child .people-name').focus();
    }
    if (act === 'close') wrap.remove();
    if (act === 'save') {
      const list = [...wrap.querySelectorAll('.people-row')].map(r => ({
        id: r.dataset.id, name: r.querySelector('.people-name').value, code: r.querySelector('.people-code').value,
        mute: r.querySelector('.people-mute-cb').checked,
      }));
      try {
        await peopleApi('PUT', { people: list, team_code: document.getElementById('peopleTeamCode').value });
        showToast('입장코드를 저장했어요.', 'success');
        wrap.remove();
      } catch (err) { showToast(err.message, 'error'); }
    }
  });
}

/** 로그인하고 처음 들어온 화면에 "OO님 어서 오세요" */
function showWelcomeOnce() {
  let who = '';
  try { who = sessionStorage.getItem('jandi.welcome') || ''; sessionStorage.removeItem('jandi.welcome'); } catch { /* 없음 */ }
  if (!who) return;
  const el = document.createElement('div');
  el.className = 'welcome-pop';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="welcome-hi">👋</span><div><b>${escapeHtml(who)}님, 어서 오세요!</b>
    <small>${AuthState.name ? '라이브 메세지에 이 이름이 같이 떠요' : '오늘도 함께 찬양해요'}</small></div>`;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3800);
}

function renderHeaderAccount() {
  const header = document.querySelector('.header-inner');
  if (!header || document.getElementById('headerAccount')) return;
  const box = document.createElement('div');
  box.id = 'headerAccount';
  box.className = 'header-account';
  let html = '';
  if (AuthState.auth) {
    if (AuthState.hasAdmin && AuthState.role !== 'admin') {
      html += `<a class="header-account-btn" href="login.html?admin=1&next=${encodeURIComponent(location.pathname + location.search)}" title="관리자로 들어가기">🔑<span class="ha-long"> 관리자</span></a>`;
    }
    const who = AuthState.name || (AuthState.role === 'admin' && AuthState.hasAdmin ? '관리자' : '팀원');
    html += `<span class="header-account-role${AuthState.name ? ' person' : ''}" title="지금 ${escapeHtml(who)}(으)로 들어와 있어요">🙋 ${escapeHtml(who)}</span>`;
    html += `<button type="button" class="header-account-btn" id="logoutBtn">로그아웃</button>`;
  }
  html += `<button type="button" class="header-account-btn theme-toggle-btn" id="themeToggleBtn"></button>`;
  box.innerHTML = html;
  header.appendChild(box);
  showWelcomeOnce();
  initThemeToggle(document.getElementById('themeToggleBtn'));
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch(`${API_BASE}/api/logout`, { method: 'POST' });
    try { localStorage.removeItem('jandi.code'); } catch (e) {}  // 로그아웃하면 저장된 입장코드도 지움
    location.href = 'login.html';
  });
}

/* ============================================================
   홈 화면에 추가 (PWA)
   ============================================================ */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  // 안드로이드 크롬: 설치 창을 잡아뒀다가 안내 창의 버튼으로 띄운다
  e.preventDefault();
  deferredInstallPrompt = e;
});

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS는 맥으로 표시됨
}

/** 휴대폰·태블릿에서 이 기기로 처음 들어왔을 때 한 번만 "홈 화면에 추가" 안내 창 */
function showInstallGuideOnce() {
  if (isStandaloneApp() || !(isIOS() || /android/i.test(navigator.userAgent))) return;
  const KEY = 'jandi_install_guide_shown';
  try {
    if (localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, '1');
  } catch { return; }   // 기억할 수 없는 환경이면 매번 뜨지 않게 아예 안 띄운다
  setTimeout(showInstallGuide, 1500);   // 안드로이드 설치 창 준비를 잠깐 기다림
}

function showInstallGuide() {
  const ios = isIOS();
  const overlay = document.createElement('div');
  overlay.className = 'install-guide';
  overlay.innerHTML = `
    <div class="install-guide-box">
      <h3>📲 홈 화면에 추가하기</h3>
      ${ios ? `
        <ol>
          <li><b>Safari</b>에서 이 페이지를 열어주세요 (카톡 안 브라우저에서는 안 돼요)</li>
          <li>아래(아이패드는 위) 공유 버튼 <span class="install-icon">⬆︎</span> 을 누르고</li>
          <li><b>"홈 화면에 추가"</b>를 누르면 끝!</li>
        </ol>` : `
        <ol>
          <li><b>크롬</b>에서 이 페이지를 열어주세요</li>
          <li>오른쪽 위 <b>⋮</b> 메뉴를 누르고</li>
          <li><b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b>를 누르세요</li>
        </ol>`}
      <p>앱처럼 아이콘을 눌러서 바로 열 수 있어요. 처음 한 번만 비밀번호를 입력하면 돼요.</p>
      ${deferredInstallPrompt ? '<button type="button" class="btn-primary" data-install="now">📲 지금 홈 화면에 추가</button><button type="button" class="btn-sm install-later">나중에</button>' : '<button type="button" class="btn-primary">알겠어요</button>'}
    </div>`;
  overlay.addEventListener('click', async e => {
    if (e.target.dataset?.install === 'now' && deferredInstallPrompt) {
      overlay.remove();
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      return;
    }
    if (e.target === overlay || e.target.tagName === 'BUTTON') overlay.remove();
  });
  document.body.appendChild(overlay);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/** 휴대폰에서 만든 PDF를 공유 시트(카톡·파일 저장 등)로 넘기고, 안 되면 일반 다운로드 */
async function saveOrShareFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
  const mobile = isIOS() || /android/i.test(navigator.userAgent);
  if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // 공유 실패 시 아래 다운로드로
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

/* ============================================================
   검색칸 ✕ — 누르면 글자를 한 번에 지운다
   ============================================================ */
const CLEARABLE_SEL = '#librarySearch, #wsSearch, #liveAddSearch, .ws-search, .live-add-search[type="search"]';
function attachClearBtn(input) {
  if (input.dataset.clearReady) return;
  input.dataset.clearReady = '1';
  const wrap = document.createElement('span');
  wrap.className = 'clear-wrap';
  const hadFocus = document.activeElement === input;
  const [a, b] = [input.selectionStart, input.selectionEnd];
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  if (hadFocus) { input.focus(); try { input.setSelectionRange(a, b); } catch { /* 일부 입력칸은 안 됨 */ } }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clear-btn';
  btn.setAttribute('aria-label', '검색어 지우기');
  btn.title = '지우기';
  btn.textContent = '✕';
  wrap.appendChild(btn);
  const sync = () => wrap.classList.toggle('has-value', !!input.value);
  input.addEventListener('input', sync);
  btn.addEventListener('mousedown', e => e.preventDefault());   // 키보드가 내려가지 않게
  btn.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    sync();
    input.focus();
  });
  sync();
}
function attachClearBtns(root = document) { root.querySelectorAll?.(CLEARABLE_SEL).forEach(attachClearBtn); }
window.addEventListener('DOMContentLoaded', () => {
  attachClearBtns();
  new MutationObserver(() => attachClearBtns()).observe(document.body, { childList: true, subtree: true });
});
