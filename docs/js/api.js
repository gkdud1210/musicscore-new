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
  renderHeaderAccount();
  initInstallButton();
});

function renderHeaderAccount() {
  const header = document.querySelector('.header-inner');
  if (!header || document.getElementById('headerAccount')) return;
  const box = document.createElement('div');
  box.id = 'headerAccount';
  box.className = 'header-account';
  let html = `<button type="button" class="header-account-btn hidden" id="installBtn">📲 홈 화면에 추가</button>`;
  if (AuthState.auth) {
    if (AuthState.hasAdmin && AuthState.role !== 'admin') {
      html += `<a class="header-account-btn" href="login.html?admin=1&next=${encodeURIComponent(location.pathname + location.search)}">🔑 관리자</a>`;
    }
    if (AuthState.role === 'admin' && AuthState.hasAdmin) html += `<span class="header-account-role">관리자</span>`;
    html += `<button type="button" class="header-account-btn" id="logoutBtn">로그아웃</button>`;
  }
  box.innerHTML = html;
  header.appendChild(box);
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch(`${API_BASE}/api/logout`, { method: 'POST' });
    location.href = 'login.html';
  });
}

/* ============================================================
   홈 화면에 추가 (PWA)
   ============================================================ */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  // 안드로이드 크롬: 설치 프롬프트를 잡아뒀다가 버튼으로 띄운다
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('installBtn')?.classList.remove('hidden');
});

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS는 맥으로 표시됨
}

function initInstallButton() {
  const btn = document.getElementById('installBtn');
  if (!btn || isStandaloneApp()) return;
  if (isIOS() || deferredInstallPrompt) btn.classList.remove('hidden');
  btn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      btn.classList.add('hidden');
      return;
    }
    showInstallGuide();
  });
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
      <button type="button" class="btn-primary">알겠어요</button>
    </div>`;
  overlay.addEventListener('click', e => {
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
