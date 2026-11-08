/**
 * 찬양 악보 라이브러리 — 곡 찾기 / 콘티 목록 / 곡 경계 보정 / 새 콘티 PDF 내보내기
 * ScoreShift
 *
 * 사용자 데이터(제목 등)는 innerHTML에 넣을 때 항상 escapeHtml을 거치고,
 * 버튼 동작은 data-action 속성 + 이벤트 위임으로 처리한다 (인라인 onclick에 문자열을 끼워넣지 않음).
 */

const SETLIST_STORAGE_KEY = 'scoreshift.setlist.v1';
const KEY_ORDER = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];

const LibState = {
  tab: 'songs',
  q: '',
  selectedKeys: new Set(),
  selectedChords: new Set(),
  facets: { keys: [], chords: [], total: 0 },
  groups: [],             // 곡 찾기 결과 (같은 제목끼리 묶음)
  groupsById: new Map(),
  contis: [],
  setlist: loadSetlist(),
  modal: null,            // { type: 'song', groupKey } | { type: 'conti', id }
  modalDirty: false,
  marks: {},              // 곡 묶음(groupKey) → ['⭐', '❤️', ...] (팀 공용 즐겨찾기 표시)
  palette: [],
  selectedMark: null,     // 즐겨찾기 필터
  selectedSection: null,  // 'before'(설교 전) | 'after'(설교 후)
  selectedTempo: null,    // 'slow' | 'fast'
  contiCat: null,         // 콘티 목록 분류 필터: before | after | slow | fast
  contiMark: null,        // 콘티 목록 즐겨찾기 필터
  contiMarkOpen: null,    // 표시 고르기를 펼친 콘티 id
};

/** 콘티 즐겨찾기는 곡 즐겨찾기와 같은 저장소에 'conti:<id>' 로 */
const contiMarkKey = id => `conti:${id}`;
const isContiMarkKey = k => k.startsWith('conti:');

const SECTION_LABEL = { before: '설교 전', after: '설교 후' };
const TEMPO_LABEL = { slow: '느린', fast: '빠른' };

window.addEventListener('DOMContentLoaded', () => {
  initBackgroundParticlesIfPresent();
  if (typeof checkServerStatus === 'function') checkServerStatus();
  initSearch();
  initUpload();
  initDelegatedActions();
  renderSetlist();
  // 로그인 권한(편집 가능 여부)을 먼저 확인해야 버튼을 맞게 그린다
  (typeof AuthState !== 'undefined' ? AuthState.ready : Promise.resolve()).finally(refreshAll);
});

function initBackgroundParticlesIfPresent() {
  const container = document.getElementById('bgParticles');
  if (!container) return;
  const colors = ['#7c6bff', '#ec4899', '#06b6d4', '#22c55e', '#f59e0b'];
  const notes = ['♩', '♪', '♫', '♬', '𝄞'];
  for (let i = 0; i < 14; i++) {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute;
      font-size: ${Math.random() * 16 + 12}px;
      left: ${Math.random() * 100}%;
      animation: floatParticle ${Math.random() * 14 + 10}s linear infinite;
      animation-delay: ${Math.random() * 12}s;
      opacity: 0;
      pointer-events: none;
      color: ${colors[Math.floor(Math.random() * colors.length)]};
    `;
    el.textContent = notes[Math.floor(Math.random() * notes.length)];
    container.appendChild(el);
  }
}

/* ============================================================
   공용 헬퍼
   ============================================================ */
async function apiJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function jsonBody(method, data) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

function keySortIndex(k) {
  const root = String(k || '').replace(/m$/, '');
  const i = KEY_ORDER.indexOf(root);
  return (i < 0 ? 99 : i) + (k.endsWith('m') ? 100 : 0);
}

function keySourceLabel(src) {
  return { explicit: '악보 표기', inferred: '코드로 추정', manual: '직접 입력' }[src] || '';
}

function img(url, alt, cls = '') {
  return `<img src="${API_BASE}${url}" alt="${escapeHtml(alt)}" loading="lazy" class="${cls}"
    onerror="this.style.visibility='hidden'; this.parentElement.classList.add('lib-thumb-fallback')" />`;
}

function nextSundayLabel() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 콘티`;
}

/* ============================================================
   데이터 불러오기
   ============================================================ */
async function refreshAll() {
  let facets, contis;
  try {
    [facets, contis] = await Promise.all([
      apiJson('/api/songs/facets', { signal: AbortSignal.timeout(10000) }),
      apiJson('/api/scores', { signal: AbortSignal.timeout(10000) }),
    ]);
  } catch (e) {
    // 네트워크/서버 오류일 때만 "연결 불가" 안내를 띄운다
    console.warn('라이브러리 로드 실패 (백엔드 오프라인?):', e);
    document.getElementById('libraryOffline').classList.remove('hidden');
    document.getElementById('songsPanel').classList.add('hidden');
    document.getElementById('contisPanel').classList.add('hidden');
    return;
  }
  LibState.facets = facets;
  LibState.contis = contis;
  await loadMarks();
  // 분석 중인 콘티가 있으면 몇 초 뒤 목록을 다시 불러온다 (업로드 창을 닫았어도 끝나면 반영)
  clearTimeout(LibState.listPoll);
  if (contis.some(c => c.status === 'processing') && !UploadQueue.running) {
    LibState.listPoll = setTimeout(() => { if (!LibState.modal) refreshAll(); }, 5000);
  }
  if (AuthState.canEdit && LibState.aiAvailable === undefined) {
    apiJson('/api/ai-status').then(r => { LibState.aiAvailable = !!r.available; LibState.engine = r.engine; }).catch(() => {});
  }
  document.getElementById('libraryOffline').classList.add('hidden');
  switchTab(LibState.tab);
  try {
    document.getElementById('songsTabCount').textContent = facets.total ? `(${facets.total})` : '';
    document.getElementById('contisTabCount').textContent = contis.length ? `(${contis.length})` : '';
    renderMarkChips();
    renderKeyChips();
    renderCategoryChips();
    renderChordChips();
    renderContis();
    await fetchSongs();
  } catch (e) {
    console.error('화면 그리기 실패:', e);
    showToast('화면을 그리는 중 오류가 났어요. 새로고침(⌘+Shift+R) 해주세요: ' + e.message, 'error', 8000);
  }
}

/** 업로드 직후: 필터를 비워서 새 곡이 가려지지 않게 하고, 방금 올린 콘티를 바로 열어 보여준다. */
function resetFilters() {
  LibState.q = '';
  LibState.selectedMark = null;
  LibState.selectedSection = null;
  LibState.selectedTempo = null;
  LibState.selectedKeys.clear();
  LibState.selectedChords.clear();
  const input = document.getElementById('librarySearch');
  if (input) input.value = '';
}

async function fetchSongs() {
  const params = new URLSearchParams();
  if (LibState.q) params.set('q', LibState.q);
  if (LibState.selectedKeys.size) params.set('key', [...LibState.selectedKeys].join(','));
  if (LibState.selectedChords.size) params.set('chords', [...LibState.selectedChords].join(','));
  if (LibState.selectedSection) params.set('section', LibState.selectedSection);
  if (LibState.selectedTempo) params.set('tempo', LibState.selectedTempo);
  try {
    const songs = await apiJson(`/api/songs?${params}`);
    LibState.groups = groupSongs(songs);
    LibState.groupsById = new Map(LibState.groups.map(g => [g.key, g]));
    renderSongs();
  } catch (e) {
    console.warn('검색 실패:', e);
  }
}

/** 같은 곡이 여러 콘티에 들어있으면 카드 하나로 묶는다.
 *  제목이 같거나, 악보 그림이 같으면(sheet_id) 같은 곡. */
function groupSongs(songs) {
  const parent = new Map();
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const link = (a, b) => {
    for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const titleKey = s => normTitle(s.title) || `__song${s.id}`;
  for (const s of songs) link('t:' + titleKey(s), 'sheet:' + (s.sheet_id || s.id));
  const map = new Map();
  for (const s of songs) {
    const root = find('t:' + titleKey(s));
    if (!map.has(root)) map.set(root, { versions: [] });
    map.get(root).versions.push(s);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    // 즐겨찾기는 제목 기준으로 저장돼 있으니, 표시가 붙은 제목이 있으면 그걸 묶음 이름으로
    const titles = g.versions.map(titleKey);
    const counts = new Map();
    titles.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
    g.key = titles.find(t => (LibState.marks[t] || []).length)
      || [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    g.versions.sort((a, b) => String(b.conti_date || '').localeCompare(String(a.conti_date || '')) || b.id - a.id);
    g.main = g.versions[0];
    g.keys = [...new Set(g.versions.map(v => v.key).filter(Boolean))].sort((a, b) => keySortIndex(a) - keySortIndex(b));
  }
  return groups;
}

/* ============================================================
   탭 / 검색 / 필터
   ============================================================ */
/* 보기 방식 (곡: 큰 그림/작은 그림/제목만 · 콘티: 그림+곡/바둑판/제목만) — 이 기기에 기억 */
const LIB_VIEWS = { songs: ['big', 'small', 'list'], contis: ['rows', 'tiles', 'list'] };
const LIB_VIEW_TARGET = { songs: 'songGrid', contis: 'contiList' };
function getLibView(kind) {
  let v = null;
  try { v = localStorage.getItem('jandi.view.' + kind); } catch { /* 저장 불가 */ }
  return LIB_VIEWS[kind].includes(v) ? v : LIB_VIEWS[kind][0];
}
function setLibView(kind, view, save = true) {
  if (!LIB_VIEWS[kind].includes(view)) return;
  if (save) { try { localStorage.setItem('jandi.view.' + kind, view); } catch { /* 저장 불가 */ } }
  const el = document.getElementById(LIB_VIEW_TARGET[kind]);
  if (el) LIB_VIEWS[kind].forEach(v => el.classList.toggle('view-' + v, v === view));
  document.querySelectorAll(`.lib-view-toggle[data-kind="${kind}"] button`).forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
}
function applyLibViews() { Object.keys(LIB_VIEWS).forEach(k => setLibView(k, getLibView(k), false)); }
document.addEventListener('DOMContentLoaded', applyLibViews);

function switchTab(tab) {
  LibState.tab = tab;
  document.querySelectorAll('.lib-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('songsPanel').classList.toggle('hidden', tab !== 'songs');
  document.getElementById('contisPanel').classList.toggle('hidden', tab !== 'contis');
}

function initSearch() {
  const input = document.getElementById('librarySearch');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      LibState.q = input.value.trim();
      if (LibState.tab !== 'songs') switchTab('songs');
      fetchSongs();
    }, 250);
  });
}

/* ============================================================
   즐겨찾기 표시 (색깔 별·하트·동그라미·네모) — 팀 전체 공용
   ============================================================ */
async function loadMarks() {
  try {
    const r = await apiJson('/api/marks');
    LibState.marks = r.marks || {};
    LibState.palette = r.palette || [];
  } catch (e) {
    console.warn('즐겨찾기 불러오기 실패:', e);
  }
}

function marksOf(groupKey) {
  return LibState.marks[groupKey] || [];
}

function renderMarkChips() {
  const row = document.getElementById('markFilterRow');
  const el = document.getElementById('markFilterChips');
  if (!row || !el) return;
  const counts = new Map();
  Object.entries(LibState.marks).forEach(([k, ms]) => {
    if (!isContiMarkKey(k)) ms.forEach(m => counts.set(m, (counts.get(m) || 0) + 1));
  });
  const used = LibState.palette.filter(m => counts.has(m));
  if (!used.length) {
    el.innerHTML = '<span class="lib-chord-empty">곡을 눌러 ⭐❤️🔵🟩 같은 표시를 붙이면 여기서 바로 모아볼 수 있어요</span>';
    return;
  }
  el.innerHTML = `<button type="button" class="lib-chord-chip${LibState.selectedMark ? '' : ' active'}" data-action="mark-filter" data-mark="">전체</button>`
    + used.map(m => `<button type="button" class="lib-chord-chip mark-chip${LibState.selectedMark === m ? ' active' : ''}"
        data-action="mark-filter" data-mark="${escapeHtml(m)}">${m} <span class="lib-chip-count">${counts.get(m)}</span></button>`).join('');
}

function markPicker(groupKey) {
  const mine = new Set(marksOf(groupKey));
  return `<div class="mark-picker" role="group" aria-label="즐겨찾기 표시">
    <span class="mark-picker-label">표시</span>
    ${LibState.palette.map(m => `<button type="button" class="mark-btn${mine.has(m) ? ' on' : ''}"
        data-action="toggle-song-mark" data-group="${escapeHtml(groupKey)}" data-mark="${escapeHtml(m)}"
        aria-pressed="${mine.has(m)}">${m}</button>`).join('')}
  </div>`;
}

async function toggleSongMark(groupKey, mark) {
  const cur = marksOf(groupKey);
  const next = cur.includes(mark) ? cur.filter(m => m !== mark) : [...cur, mark];
  LibState.marks[groupKey] = next;           // 화면은 바로 바꾸고
  if (!next.length) delete LibState.marks[groupKey];
  rerenderMarks();
  try {
    await apiJson('/api/marks', jsonBody('POST', { group_key: groupKey, marks: next }));
  } catch (e) {
    showToast('표시 저장 실패: ' + e.message, 'error');
    if (cur.length) LibState.marks[groupKey] = cur; else delete LibState.marks[groupKey];
    rerenderMarks();
  }
}

function rerenderMarks() {
  renderMarkChips();
  renderSongs();
  renderContis();
  if (LibState.modal?.type === 'song') renderSongModal();
  // 콘티 화면은 고치던 내용이 사라지지 않게 버튼만 바꾼다
  document.querySelectorAll('#libModalBody [data-action="toggle-song-mark"]').forEach(b => {
    const on = marksOf(b.dataset.group).includes(b.dataset.mark);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
}

function renderCategoryChips() {
  const el = document.getElementById('categoryChips');
  if (!el) return;
  const cats = LibState.facets.categories || {};
  const chip = (kind, val, label) => {
    const on = (kind === 'section' ? LibState.selectedSection : LibState.selectedTempo) === val;
    return `<button type="button" class="lib-chord-chip cat-chip cat-${val}${on ? ' active' : ''}" data-action="cat-filter"
      data-kind="${kind}" data-val="${val}">${label} <span class="lib-chip-count">${cats[val] || 0}</span></button>`;
  };
  el.innerHTML = chip('section', 'before', '🙏 설교 전 찬양') + chip('section', 'after', '🕊 설교 후 찬양')
    + chip('tempo', 'slow', '🐢 느린 찬양') + chip('tempo', 'fast', '🐇 빠른 찬양')
    + (Object.values(cats).some(Boolean) ? '' : '<span class="lib-chord-empty">콘티를 열어 곡마다 설교 전/후, 느린/빠른을 골라주세요</span>');
}

function songTags(s) {
  return `${s.section ? `<span class="song-tag tag-${s.section}">${SECTION_LABEL[s.section]}</span>` : ''}${s.tempo ? `<span class="song-tag tag-${s.tempo}">${TEMPO_LABEL[s.tempo]}</span>` : ''}`;
}

function renderKeyChips() {
  const el = document.getElementById('keyFilterChips');
  const keys = [...LibState.facets.keys].sort((a, b) => keySortIndex(a.key) - keySortIndex(b.key));
  if (!keys.length) {
    el.innerHTML = '<span class="lib-chord-empty">콘티를 올리면 키(조)별로 모아볼 수 있어요</span>';
    return;
  }
  const all = `<button type="button" class="lib-chord-chip${LibState.selectedKeys.size ? '' : ' active'}" data-action="key-all">전체</button>`;
  el.innerHTML = all + keys.map(k => `
    <button type="button" class="lib-chord-chip lib-key-chip${LibState.selectedKeys.has(k.key) ? ' active' : ''}"
            data-action="toggle-key" data-key="${escapeHtml(k.key)}">
      ${escapeHtml(k.key)} <span class="lib-chip-count">${k.count}</span>
    </button>`).join('');
}

function renderChordChips() {
  const el = document.getElementById('chordFilterChips');
  const chords = LibState.facets.chords || [];
  el.innerHTML = chords.length
    ? chords.map(c => `<button type="button" class="lib-chord-chip${LibState.selectedChords.has(c) ? ' active' : ''}"
        data-action="toggle-chord" data-chord="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')
    : '<span class="lib-chord-empty">인식된 코드가 없어요</span>';
}

/* ============================================================
   곡 카드 그리드
   ============================================================ */
function renderSongs() {
  const grid = document.getElementById('songGrid');
  const empty = document.getElementById('songsEmpty');
  const groups = LibState.selectedMark
    ? LibState.groups.filter(g => marksOf(g.key).includes(LibState.selectedMark))
    : LibState.groups;
  const total = groups.reduce((n, g) => n + new Set(g.versions.map(v => v.sheet_id)).size, 0);
  renderDupSheetBanner(groups);
  document.getElementById('songsCount').textContent =
    groups.length ? `${LibState.selectedMark ? LibState.selectedMark + ' ' : ''}${groups.length}곡 (악보 ${total}장)` : '';

  if (!groups.length) {
    grid.innerHTML = '';
    const filtered = LibState.q || LibState.selectedKeys.size || LibState.selectedChords.size || LibState.selectedMark
      || LibState.selectedSection || LibState.selectedTempo;
    document.getElementById('songsEmptyTitle').textContent = filtered ? '조건에 맞는 곡이 없어요' : '아직 업로드한 콘티가 없어요';
    document.getElementById('songsEmptySub').textContent = filtered ? '검색어나 키 필터를 바꿔보세요' : '위의 "PDF·사진 업로드" 버튼으로 올려보세요';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = groups.map(renderSongCard).join('');
}

/** 같은 제목·키인데 악보가 여러 장인 곡 → 하나만 남기도록 안내 */
function dupSheetBuckets(versions) {
  const byKey = new Map();
  for (const v of versions) {
    // 키를 모르거나 제목을 못 읽은 곡은 같은 곡인지 모르니 따로 둔다
    const k = normTitle(v.title) === normTitle('제목 없음') ? '' : (v.key || '').trim();
    if (!byKey.has(k)) byKey.set(k, new Map());
    const sheets = byKey.get(k);
    if (!sheets.has(v.sheet_id)) sheets.set(v.sheet_id, []);
    sheets.get(v.sheet_id).push(v);
  }
  return byKey;   // 키 → (악보 번호 → 그 악보를 쓰는 곡들)
}

function renderDupSheetBanner(groups) {
  const box = document.getElementById('dupSheetBanner');
  if (!box) return;
  const dups = AuthState.canEdit ? groups.filter(g =>
    [...dupSheetBuckets(g.versions).entries()].some(([k, sheets]) => k && sheets.size > 1)) : [];
  box.innerHTML = dups.length ? `
    <div class="dup-sheet-banner">
      <p>🗂 제목·키가 같은데 악보가 여러 장인 곡이 <b>${dups.length}곡</b> 있어요. 눌러서 남길 악보 하나를 골라주세요.</p>
      <div class="dup-sheet-chips">${dups.map(g => `<button type="button" class="btn-sm" data-action="open-song" data-group="${escapeHtml(g.key)}">${escapeHtml(g.main.title)}</button>`).join('')}</div>
    </div>` : '';
}

function inSetlist(songId) {
  return LibState.setlist.some(s => s.id === songId);
}

function addButton(song, extraCls = '') {
  const on = inSetlist(song.id);
  return `<button type="button" class="song-add-btn${on ? ' on' : ''} ${extraCls}" data-action="toggle-set" data-id="${song.id}">
    ${on ? '✓ 담김' : '＋ 콘티에 담기'}</button>`;
}

function groupTags(g) {
  const sec = [...new Set(g.versions.map(v => v.section).filter(Boolean))];
  const tem = [...new Set(g.versions.map(v => v.tempo).filter(Boolean))];
  if (!sec.length && !tem.length) return '';
  return `<div class="song-tags">${sec.map(x => `<span class="song-tag tag-${x}">${SECTION_LABEL[x]}</span>`).join('')}${tem.map(x => `<span class="song-tag tag-${x}">${TEMPO_LABEL[x]}</span>`).join('')}</div>`;
}

function renderSongCard(g) {
  const s = g.main;
  const pages = s.page_end - s.page_start + 1;
  const uses = g.versions.length;
  const meta = uses > 1
    ? `콘티 ${uses}회 · 최근 ${escapeHtml(s.conti_date || s.conti_title)}`
    : escapeHtml(s.conti_date || s.conti_title);
  const otherKeys = g.keys.length > 1
    ? `<div class="lib-card-chords">${g.keys.map(k => `<span class="lib-card-chord">${escapeHtml(k)}</span>`).join('')}</div>`
    : '';
  return `
    <div class="lib-card song-card">
      <div class="lib-card-thumb song-thumb" data-action="open-song" data-group="${escapeHtml(g.key)}">
        ${img(s.image_urls[0], s.title)}
        ${s.key ? `<span class="song-key-badge" title="${escapeHtml(keySourceLabel(s.key_source))}">${escapeHtml(s.key)}</span>` : ''}
        ${pages > 1 ? `<span class="lib-card-pages">${pages}p</span>` : ''}
      </div>
      <div class="lib-card-body">
        <p class="lib-card-title" data-action="open-song" data-group="${escapeHtml(g.key)}">${s.key ? `<span class="song-key-inline">${escapeHtml(s.key)}</span>` : ''}${marksOf(g.key).length ? `<span class="card-marks">${marksOf(g.key).join('')}</span> ` : ''}${escapeHtml(s.title)}</p>
        <p class="song-meta">${meta}</p>
        ${groupTags(g)}
        ${otherKeys}
      </div>
      <div class="song-card-actions">${addButton(s)}</div>
    </div>`;
}

/* ============================================================
   곡 상세 모달 (같은 곡의 모든 버전 + 악보 이미지 전체)
   ============================================================ */
function sortVersions(versions) {
  return versions.sort((a, b) =>
    String(b.conti_date || '').localeCompare(String(a.conti_date || '')) || b.score_id - a.score_id || a.page_start - b.page_start);
}

async function openSongModal(groupKey) {
  const g = LibState.groupsById.get(groupKey);
  if (!g) return;
  LibState.modal = { type: 'song', groupKey, title: g.main.title, versions: [...g.versions] };
  renderSongModal();
  showModal();
  // 검색/키 필터와 상관없이 이 곡이 들어간 모든 콘티를 보여주기 위해 같은 제목의 곡을 전부 다시 가져온다
  await loadAllVersions();
}

async function loadAllVersions() {
  const modal = LibState.modal;
  if (!modal || modal.type !== 'song') return;
  try {
    const target = normTitle(modal.title);
    const sheets = new Set((modal.versions || []).map(v => v.sheet_id));
    const all = await apiJson('/api/songs');
    const versions = all.filter(s => normTitle(s.title) === target || sheets.has(s.sheet_id));
    if (versions.length && LibState.modal === modal) {
      modal.versions = sortVersions(versions);
      renderSongModal();
    }
  } catch (e) {
    console.warn('곡 버전 불러오기 실패:', e);
  }
}

function renderSongModal() {
  document.querySelector('.lib-modal-box')?.classList.remove('wide');
  const m = LibState.modal;
  const versions = m.versions || [];
  if (!versions.length) { closeModal(true); return; }
  const contiCount = new Set(versions.map(v => v.score_id)).size;
  document.getElementById('libModalBody').innerHTML = `
    <h2 class="lib-modal-title">${escapeHtml(versions[0].title)}</h2>
    <p class="lib-modal-sub">${contiCount > 1 ? `${contiCount}개 콘티에서 사용했어요` : '1개 콘티에서 사용했어요'}</p>
    ${markPicker(m.groupKey)}
    ${tempoPicker(versions)}
    ${renderSongContis(versions)}
    ${renderSheets(versions)}`;
}

/** 빠르기(느린/빠른)는 곡의 성질이라 이 곡의 모든 악보에 한 번에 */
function tempoPicker(versions) {
  const cur = versions.find(v => v.tempo)?.tempo || '';
  return `<div class="mark-picker tempo-picker" role="group" aria-label="빠르기">
    <span class="mark-picker-label">빠르기</span>
    ${['slow', 'fast'].map(t => `<button type="button" class="tempo-btn${cur === t ? ' on' : ''}" data-action="set-group-tempo"
      data-tempo="${cur === t ? '' : t}" ${AuthState.canEdit ? '' : 'disabled'}>${t === 'slow' ? '🐢 느린 찬양' : '🐇 빠른 찬양'}</button>`).join('')}
  </div>`;
}

async function setGroupTempo(tempo) {
  const m = LibState.modal;
  if (!m || m.type !== 'song') return;
  // 같은 악보끼리는 서버가 같이 바꿔주니, 악보 묶음마다 하나씩만 보낸다
  const reps = [...new Map(m.versions.map(v => [v.sheet_id, v])).values()];
  try {
    for (const v of reps) await apiJson(`/api/songs/${v.id}`, jsonBody('PATCH', { tempo }));
    m.versions.forEach(v => { v.tempo = tempo; });
    renderSongModal();
    LibState.modalDirty = true;
    showToast(tempo ? `${TEMPO_LABEL[tempo]} 찬양으로 표시했어요` : '빠르기 표시를 지웠어요', 'success');
  } catch (e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}

/** 같은 그림의 악보는 한 번만 보여주고, 어느 콘티들에 쓰였는지 적는다.
 *  제목·키가 같은 악보가 여러 장이면 하나만 보여주고, 나머지는 접어두고 "이 악보만 남기기"로 고르게 한다. */
function renderSheets(versions) {
  const buckets = dupSheetBuckets(versions);
  const keys = [...buckets.keys()].sort((a, b) => keySortIndex(a) - keySortIndex(b));
  let shown = 0;
  const html = keys.map(k => {
    // 많이 쓰인 악보(남긴 악보)를 맨 앞에
    const sheets = [...buckets.get(k).values()].sort((a, b) =>
      b.length - a.length || String(b[0].conti_date || '').localeCompare(String(a[0].conti_date || '')));
    shown++;
    if (sheets.length === 1 || !k) {
      shown += sheets.length - 1;
      return sheets.map(list => renderSongVersion(list[0], list)).join('');
    }
    const ids = sheets.flat().map(v => v.id).join(',');
    const keepBtn = list => AuthState.canEdit
      ? `<button type="button" class="btn-primary btn-compact keep-sheet-btn" data-action="keep-sheet" data-id="${list[0].id}" data-ids="${ids}" data-key="${escapeHtml(k)}">⭐ 이 악보만 남기기</button>` : '';
    return `
      ${renderSongVersion(sheets[0][0], sheets[0], keepBtn(sheets[0]))}
      <details class="dup-sheets">
        <summary>🗂 ${escapeHtml(k)}키 악보가 ${sheets.length - 1}장 더 있어요 — 열어서 남길 악보를 고르세요</summary>
        <p class="dup-sheets-sub">"이 악보만 남기기"를 누르면 나머지 악보는 목록에서 사라지고, 그 악보가 들어있던 콘티에서도 남긴 악보로 보여요 (콘티 순서는 그대로).</p>
        ${sheets.slice(1).map(list => renderSongVersion(list[0], list, keepBtn(list))).join('')}
      </details>`;
  }).join('');
  return `<h3 class="song-section-title">🎼 악보 <span>${shown}</span>
      ${versions.length > shown ? `<small class="sheet-dup-note">같은 악보는 하나로 모았어요 (콘티 ${versions.length}곳)</small>` : ''}</h3>
    ${html}`;
}

async function keepSheet(id, ids, key) {
  const others = ids.filter(x => x !== id);
  if (!confirm(`이 악보만 남길까요?\n\n${key}키의 다른 악보는 곡 목록에서 사라지고, 그 악보가 들어있던 콘티에서도 이 악보로 보여요.\n(원본 PDF는 지우지 않아서 콘티 화면에서 "원래 악보로" 되돌릴 수 있어요)`)) return;
  try {
    await apiJson(`/api/songs/${id}/keep`, jsonBody('POST', { song_ids: others }));
    showToast('이 악보만 남겼어요.', 'success');
    LibState.modalDirty = true;
    await refreshAll();
    await loadAllVersions();
  } catch (e) {
    showToast('실패: ' + e.message, 'error');
  }
}

async function restoreSheet(id) {
  try {
    await apiJson(`/api/songs/${id}/restore`, { method: 'POST' });
    showToast('원래 악보로 되돌렸어요.', 'success');
    LibState.modalDirty = true;
    if (LibState.modal?.type === 'conti') await reloadContiModal();
  } catch (e) {
    showToast('실패: ' + e.message, 'error');
  }
}

/** 이 곡이 들어간 콘티 목록 — 콘티마다 전체 곡 순서를 보여주고, 이 곡은 강조 */
function renderSongContis(versions) {
  const versionIds = new Set(versions.map(v => v.id));
  const contiIds = [...new Set(versions.map(v => v.score_id))];
  const rows = contiIds.map(id => {
    const c = LibState.contis.find(x => x.id === id);
    if (c) return c;
    const v = versions.find(x => x.score_id === id); // 목록에 아직 없으면 곡 정보로 최소 표시
    return { id, title: v.conti_title, conti_date: v.conti_date, songs: [] };
  }).sort((a, b) => String(b.conti_date || '').localeCompare(String(a.conti_date || '')) || b.id - a.id);

  return `
    <section class="song-contis">
      <h3 class="song-section-title">📁 이 곡이 들어간 콘티 <span>${rows.length}</span></h3>
      ${rows.map(c => {
        const here = c.songs.filter(s => versionIds.has(s.id));
        const keys = [...new Set(here.map(s => s.key).filter(Boolean))].join(', ');
        return `
        <div class="song-conti-row">
          <div class="song-conti-head">
            <button type="button" class="song-conti-name" data-action="open-conti" data-id="${c.id}">
              ${c.conti_date ? `<span class="song-conti-date">${escapeHtml(c.conti_date)}</span>` : ''}
              <span>${escapeHtml(c.title)}</span>
            </button>
            ${keys ? `<span class="song-conti-key">이 곡 키: <b>${escapeHtml(keys)}</b></span>` : ''}
            <div class="song-conti-actions">
              <button type="button" class="btn-sm" data-action="open-conti" data-id="${c.id}">콘티 보기</button>
              <button type="button" class="btn-sm" data-action="add-conti" data-id="${c.id}">＋ 전체 담기</button>
            </div>
          </div>
          ${c.songs.length ? `<div class="conti-songs">
            ${c.songs.map((s, i) => `<span class="conti-song-chip${versionIds.has(s.id) ? ' current' : ''}">${i + 1}. ${escapeHtml(s.title)}${s.key ? ` <b>${escapeHtml(s.key)}</b>` : ''}</span>`).join('')}
          </div>` : ''}
        </div>`;
      }).join('')}
    </section>`;
}

function renderSongVersion(s, same = [s], extraBtn = '') {
  const range = s.page_start === s.page_end ? `p.${s.page_start}` : `p.${s.page_start}–${s.page_end}`;
  const usedIn = same.length > 1
    ? `<p class="sheet-used-in">🔁 이 악보가 쓰인 콘티 ${same.length}곳: ${same.map(v => escapeHtml(v.conti_date || v.conti_title)).join(', ')}</p>` : '';
  return `
    <div class="song-version" data-song="${s.id}">
      <div class="song-version-head">
        <span class="song-key-badge static">${escapeHtml(s.key || '?')}</span>
        <div class="song-version-info">
          <strong>${escapeHtml(s.title)}</strong>
          <span>${escapeHtml(s.conti_title)}${s.conti_date ? ` · ${escapeHtml(s.conti_date)}` : ''} · ${range}
            ${s.key_source ? ` · 키: ${escapeHtml(keySourceLabel(s.key_source))}` : ''}</span>
        </div>
        <div class="song-version-actions">
          ${extraBtn}
          ${addButton(s)}
          <button class="btn-sm admin-only" data-action="edit-song" data-id="${s.id}">✏️ 수정</button>
          <a class="btn-sm" href="viewer.html?id=${s.score_id}&page=${s.page_start}">✍️ 필기</a>
        </div>
      </div>
      ${usedIn}
      <form class="song-edit admin-only hidden" id="songEdit-${s.id}" data-action-submit="save-song" data-id="${s.id}">
        <input type="text" name="title" class="lib-edit-title-input" value="${escapeHtml(s.title)}" placeholder="제목" />
        <input type="text" name="key" class="lib-edit-title-input song-key-input" value="${escapeHtml(s.key)}" placeholder="키 (예: G, Bb, Am)" />
        <button type="submit" class="btn-primary btn-compact">저장</button>
      </form>
      <div class="song-pages">${s.image_urls.map(u => `<div class="song-page">${img(u, s.title)}</div>`).join('')}</div>
    </div>`;
}

async function saveSong(id, form) {
  const title = form.elements.title.value.trim();
  const key = form.elements.key.value.trim();
  try {
    await apiJson(`/api/songs/${id}`, jsonBody('PATCH', { title, key }));
    showToast('수정했습니다.', 'success');
    updateSetlistItem(id, { title, key });
    LibState.modalDirty = true;
    if (LibState.modal?.type === 'conti') await reloadContiModal();
    else {
      await refreshAll();
      // 제목이 바뀌었을 수 있으니 바뀐 제목 기준으로 같은 곡들을 다시 모은다
      if (LibState.modal?.type === 'song') {
        LibState.modal.title = title || LibState.modal.title;
        await loadAllVersions();
      }
    }
  } catch (e) {
    showToast('수정 실패: ' + e.message, 'error');
  }
}

/* ============================================================
   콘티 목록
   ============================================================ */
const CONTI_CATS = [
  ['before', '🙏 설교 전', s => s.section === 'before'],
  ['after', '🕊 설교 후', s => s.section === 'after'],
  ['slow', '🐢 느린', s => s.tempo === 'slow'],
  ['fast', '🐇 빠른', s => s.tempo === 'fast'],
];
const contiCatTest = val => (CONTI_CATS.find(c => c[0] === val) || [])[2];

function renderContiFilters(base) {
  const catEl = document.getElementById('contiCatChips');
  const markEl = document.getElementById('contiMarkChips');
  if (!catEl || !markEl) return;
  // 분류 숫자는 지금 고른 즐겨찾기 안에서, 즐겨찾기 숫자는 지금 고른 분류 안에서 센다
  const inMark = base.filter(c => !LibState.contiMark || marksOf(contiMarkKey(c.id)).includes(LibState.contiMark));
  const inCat = base.filter(c => !LibState.contiCat || c.songs.some(contiCatTest(LibState.contiCat)));
  catEl.innerHTML = `<button type="button" class="lib-chord-chip${LibState.contiCat ? '' : ' active'}" data-action="conti-cat" data-val="">전체</button>`
    + CONTI_CATS.map(([val, label, test]) => `<button type="button" class="lib-chord-chip cat-chip cat-${val}${LibState.contiCat === val ? ' active' : ''}"
        data-action="conti-cat" data-val="${val}">${label} <span class="lib-chip-count">${inMark.filter(c => c.songs.some(test)).length}</span></button>`).join('');
  const counts = new Map();
  inCat.forEach(c => marksOf(contiMarkKey(c.id)).forEach(m => counts.set(m, (counts.get(m) || 0) + 1)));
  const anyUsed = new Set(base.flatMap(c => marksOf(contiMarkKey(c.id))));
  const used = LibState.palette.filter(m => anyUsed.has(m) || LibState.contiMark === m);
  markEl.innerHTML = used.length
    ? `<button type="button" class="lib-chord-chip${LibState.contiMark ? '' : ' active'}" data-action="conti-mark-filter" data-mark="">전체</button>`
      + used.map(m => `<button type="button" class="lib-chord-chip mark-chip${LibState.contiMark === m ? ' active' : ''}"
          data-action="conti-mark-filter" data-mark="${escapeHtml(m)}">${m} <span class="lib-chip-count">${counts.get(m) || 0}</span></button>`).join('')
    : '<span class="lib-chord-empty">콘티 옆 "☆ 표시"를 눌러 ⭐❤️ 같은 표시를 붙이면 여기서 모아볼 수 있어요</span>';
}

function contiMarkPicker(c) {
  const mine = new Set(marksOf(contiMarkKey(c.id)));
  const open = LibState.contiMarkOpen === c.id;
  return `<div class="conti-mark-row">
    <button type="button" class="btn-sm conti-mark-toggle" data-action="conti-mark-open" data-id="${c.id}" aria-expanded="${open}">${mine.size ? [...mine].join('') : '☆'} 표시</button>
    ${open ? `<span class="conti-mark-pick">${LibState.palette.map(m => `<button type="button" class="mark-btn${mine.has(m) ? ' on' : ''}"
        data-action="toggle-song-mark" data-group="${contiMarkKey(c.id)}" data-mark="${escapeHtml(m)}" aria-pressed="${mine.has(m)}">${m}</button>`).join('')}</span>` : ''}
  </div>`;
}

function renderContis() {
  const list = document.getElementById('contiList');
  const empty = document.getElementById('contisEmpty');
  renderContiFilters(LibState.contis);
  if (!LibState.contis.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    document.getElementById('contisCount').textContent = '';
    return;
  }
  empty.classList.add('hidden');
  const test = contiCatTest(LibState.contiCat);
  const shown = LibState.contis.filter(c =>
    (!test || c.songs.some(test)) && (!LibState.contiMark || marksOf(contiMarkKey(c.id)).includes(LibState.contiMark)));
  const filtered = test || LibState.contiMark;
  document.getElementById('contisCount').textContent = filtered
    ? `${LibState.contiMark || ''} ${LibState.contiCat ? CONTI_CATS.find(x => x[0] === LibState.contiCat)[1] : ''} 콘티 ${shown.length}개`.trim()
    : `콘티 ${shown.length}개`;
  const pendingCount = LibState.contis.filter(c => !c.confirmed).length;
  list.innerHTML = (pendingCount ? `
    <div class="review-banner compact">
      <span>🆕 업로드 후 확인하지 않은 콘티가 <b>${pendingCount}개</b> 있어요. 확인해야 라이브러리 검색에 나와요.</span>
      <button class="btn-primary btn-compact" data-action="review-next">확인하러 가기</button>
    </div>` : '') + (shown.length ? '' : '<p class="lib-chord-empty conti-filter-empty">조건에 맞는 콘티가 없어요. 위에서 "전체"를 눌러보세요.</p>')
    + shown.map(c => {
      const marks = marksOf(contiMarkKey(c.id));
      return `
    <div class="conti-row${c.confirmed ? '' : ' pending'}">
      <div class="conti-thumb lib-card-thumb" data-action="open-conti" data-id="${c.id}">${img(c.thumbnail_url, c.title)}</div>
      <div class="conti-info">
        <p class="conti-title" data-action="open-conti" data-id="${c.id}">${marks.length ? `<span class="card-marks">${marks.join('')}</span> ` : ''}${(c.overlaps || []).some(o => o.kind !== 'partial') ? '<span class="pending-badge dup">겹치는 콘티</span> ' : ''}${c.status === 'processing' ? `<span class="pending-badge processing">분석 중 ${escapeHtml(c.status_detail || '')}</span> ` : c.confirmed ? '' : '<span class="pending-badge">확인 필요</span> '}${escapeHtml(c.title)}</p>
        <p class="song-meta">${c.conti_date ? `📅 ${escapeHtml(c.conti_date)} · ` : ''}${c.songs.length}곡 · ${c.page_count}페이지</p>
        <div class="conti-songs">
          ${c.songs.map((s, i) => `<span class="conti-song-chip${s.section ? ' sec-' + s.section : ''}${test ? (test(s) ? ' hit' : ' dim') : ''}" title="${[s.section && SECTION_LABEL[s.section], s.tempo && TEMPO_LABEL[s.tempo]].filter(Boolean).join(' · ')}">${i + 1}. ${escapeHtml(s.title)}${s.key ? ` <b>${escapeHtml(s.key)}</b>` : ''}${s.tempo === 'slow' ? ' 🐢' : s.tempo === 'fast' ? ' 🐇' : ''}</span>`).join('')
            || '<span class="lib-card-nochords">곡이 없어요 — "곡 나누기·수정"에서 분석해주세요</span>'}
        </div>
        ${contiMarkPicker(c)}
      </div>
      <div class="conti-actions">
        <button class="btn-sm" data-action="open-conti" data-id="${c.id}">${AuthState.canEdit ? '🧩 곡 나누기·수정' : '📄 악보 보기'}</button>
        <button class="btn-sm" data-action="add-conti" data-id="${c.id}">＋ 전체 담기</button>
        <a class="btn-sm" href="viewer.html?id=${c.id}">✍️ 필기</a>
        <button class="btn-sm admin-only" data-action="delete-conti" data-id="${c.id}">🗑️</button>
      </div>
    </div>`;
    }).join('');
}

/* ============================================================
   콘티 상세 모달 — 페이지별 곡 경계 보정 (합치기/나누기/빼기/추가)
   ============================================================ */
async function openContiModal(id) {
  // 곡 화면에서 콘티로 들어왔으면 "뒤로" 버튼으로 곡 화면에 돌아갈 수 있게 기억
  const back = LibState.modal?.type === 'song' ? LibState.modal : null;
  LibState.modal = { type: 'conti', id, back };
  showModal();
  document.getElementById('libModalBody').innerHTML = '<p class="lib-modal-sub">불러오는 중...</p>';
  await reloadContiModal();
}

async function reloadContiModal() {
  const id = LibState.modal.id;
  try {
    const [conti, songs] = await Promise.all([
      apiJson(`/api/scores/${id}`),
      apiJson(`/api/songs?score_id=${id}`),
    ]);
    LibState.modal.songs = songs;
    renderContiModal(conti, songs);
    const back = LibState.modal.back;
    if (back) {
      const body = document.getElementById('libModalBody');
      body.insertAdjacentHTML('afterbegin',
        `<button type="button" class="btn-link modal-back" data-action="modal-back">← "${escapeHtml(back.title)}" 로 돌아가기</button>`);
    }
    document.querySelector('.lib-modal')?.scrollTo(0, 0);
  } catch (e) {
    showToast('콘티를 불러오지 못했어요: ' + e.message, 'error');
    closeModal(true);
  }
}

function renderContiProcessing(conti) {
  document.getElementById('libModalBody').innerHTML = `
    <h2 class="lib-modal-title">${escapeHtml(conti.title)}</h2>
    <div class="lib-upload-progress">
      <div class="lib-upload-spinner"></div>
      <div>
        <p class="lib-upload-progress-title">분석하는 중이에요 · ${escapeHtml(conti.status_detail || '')}</p>
        <p class="lib-upload-progress-sub">끝나면 이 화면이 저절로 바뀌어요. 창을 닫아도 분석은 계속돼요.</p>
      </div>
    </div>`;
  const id = conti.id;
  clearTimeout(LibState.modalPoll);
  LibState.modalPoll = setTimeout(() => {
    if (LibState.modal?.type === 'conti' && LibState.modal.id === id) {
      LibState.modalDirty = true;
      reloadContiModal();
    }
  }, 3000);
}

function renderContiModal(conti, songs) {
  songs.sort((a, b) => a.page_start - b.page_start);
  if (conti.status === 'processing') { renderContiProcessing(conti); return; }
  if (!AuthState.canEdit) { renderContiModalReadOnly(conti, songs); return; }
  const pageToSong = new Map();
  songs.forEach(s => { for (let p = s.page_start; p <= s.page_end; p++) pageToSong.set(p, s); });

  // 페이지 순서대로: 곡 블록 또는 곡에 속하지 않은 페이지
  const blocks = [];
  for (let p = 1; p <= conti.page_count; p++) {
    const s = pageToSong.get(p);
    if (!s) blocks.push({ orphan: p });
    else if (s.page_start === p) blocks.push({ song: s });
  }
  let songIndex = 0;
  const pending = !conti.confirmed;
  const confirmBtn = pending
    ? `<button type="button" class="btn-primary confirm-btn" data-action="confirm-conti" data-id="${conti.id}">✅ 확인 완료 — 라이브러리에 넣기</button>`
    : '';

  document.getElementById('libModalBody').innerHTML = `
    ${pending ? `
      <div class="review-banner">
        <p class="review-banner-title">🆕 업로드 확인 중 · 아직 라이브러리 검색에는 안 나와요</p>
        <p class="review-banner-sub">
          곡이 제대로 나뉘었는지, 제목·키가 맞는지 확인해주세요.<br>
          · 한 칸에 악보 두 개가 붙어 있으면 → 두 번째 악보 아래 <b>✂ 따로 분리</b><br>
          · 필요 없는 페이지(표지·순서지·잘못 붙은 악보) → <b>🗑 페이지 빼기</b><br>
          · 한 곡이 둘로 나뉘었으면 → 뒤쪽 곡의 <b>⤴ 앞 곡과 합치기</b>
        </p>
        ${confirmBtn}
      </div>` : ''}
    ${overlapBanner(conti)}
    ${markPicker(contiMarkKey(conti.id))}
    <form class="conti-edit-head" data-action-submit="save-conti" data-id="${conti.id}">
      <input type="text" name="title" class="lib-edit-title-input conti-title-input" value="${escapeHtml(conti.title)}" />
      <input type="date" name="conti_date" class="lib-edit-title-input" value="${escapeHtml(conti.conti_date || '')}" />
    </form>
    <div class="now-row"><button type="button" class="btn-now" data-live="send-conti">📡 NOW · 지금 이 콘티 띄우기</button></div>
    <p class="lib-modal-sub">
      자동으로 나눈 곡이 틀렸다면 여기서 고쳐주세요. 표지·순서지 페이지는 "곡에서 빼기"를 누르면 검색에 안 나와요.
      <button class="btn-link" data-action="reprocess" data-id="${conti.id}">처음부터 다시 분석${LibState.engine === 'gemini' ? ' (✨ 제미나이)' : ''}</button>
    </p>
    ${conti.status === 'error' ? `<p class="conti-hint error-hint">⚠️ ${escapeHtml(conti.status_detail)}</p>` : ''}
    ${isPhpServer() ? '' : `<div class="ai-row">
      ${LibState.aiAvailable
        ? `<button type="button" class="btn-sm ai-btn" data-action="reprocess-ai" data-id="${conti.id}">🤖 AI(Claude)로 다시 인식</button>
           <span class="ai-row-sub">제목·키가 많이 틀렸을 때. 페이지마다 Claude가 읽어요 (API 사용료 발생)</span>`
        : `<span class="ai-row-sub">🤖 인식이 잘 안 되면 서버에 Claude API 키를 넣고 "AI로 다시 인식"을 쓸 수 있어요</span>`}
    </div>`}
    ${contiViewBar()}
    <div class="conti-songs-wrap" id="contiSongsWrap">
    ${blocks.map(b => {
      if (b.orphan) {
        return `
          <div class="conti-song orphan">
            <div class="conti-song-head"><span class="lib-card-nochords">곡에 포함되지 않은 페이지</span>
              <button class="btn-sm" data-action="add-page-song" data-score="${conti.id}" data-page="${b.orphan}">＋ 곡으로 추가</button></div>
            <div class="song-pages small"><figure class="song-page">${img(`/api/scores/${conti.id}/pages/${b.orphan}/image`, '')}<figcaption>p.${b.orphan}</figcaption></figure></div>
          </div>`;
      }
      const s = b.song;
      const isFirst = songIndex++ === 0;
      const suspicious = !s.chords.length && !s.key;
      return `
        <div class="conti-song${suspicious ? ' suspicious' : ''}">
          <form class="conti-song-head" data-action-submit="save-song" data-id="${s.id}">
            <span class="conti-song-no">${songIndex}</span>
            <input type="text" name="title" class="lib-edit-title-input" value="${escapeHtml(s.title)}" />
            <input type="text" name="key" class="lib-edit-title-input song-key-input" value="${escapeHtml(s.key)}" placeholder="키" title="${escapeHtml(keySourceLabel(s.key_source))}" />
            ${isFirst ? '' : `<button type="button" class="btn-sm" data-action="merge-prev" data-id="${s.id}" title="앞 곡의 다음 페이지로 합치기">⤴ 앞 곡과 합치기</button>`}
            <button type="button" class="btn-sm" data-action="delete-song" data-id="${s.id}">곡에서 빼기</button>
            ${addButton(s)}
            <div class="song-cats">
              <span class="song-cats-label">분류</span>
              ${choiceChip('section', 'before', '설교 전', s.section)}${choiceChip('section', 'after', '설교 후', s.section)}
              <span class="song-cats-sep"></span>
              ${choiceChip('tempo', 'slow', '🐢 느린', s.tempo)}${choiceChip('tempo', 'fast', '🐇 빠른', s.tempo)}
              ${isFirst ? '' : `<button type="button" class="btn-link from-here" data-action="from-here-after" data-index="${songIndex - 1}" title="앞 곡들은 설교 전, 이 곡부터는 설교 후로">⬇ 여기부터 설교 후</button>`}
              ${s.matched ? '<span class="matched-badge" title="전에 확인한 콘티에 같은 악보가 있어서 제목·키를 가져왔어요">🔁 전에 확인한 악보</span>' : ''}
            </div>
          </form>
          ${s.use_song_id ? `<p class="conti-hint kept-hint">⭐ 같은 제목·키의 남긴 악보로 보여주고 있어요.
            <button type="button" class="btn-link" data-action="restore-sheet" data-id="${s.id}">↩ 이 콘티의 원래 악보로</button></p>` : ''}
          ${suspicious ? '<p class="conti-hint">코드와 키를 찾지 못했어요. 표지·순서지라면 "곡에서 빼기"를 눌러주세요.</p>' : ''}
          <div class="song-pages small">
            ${s.image_urls.map((u, i) => {
              const page = s.page_start + i;
              if (s.use_song_id) return `<figure class="song-page">${img(u, s.title)}</figure>`;
              return `<figure class="song-page">${img(u, s.title)}
                <figcaption><span>p.${page}</span>
                  <span class="page-tools">
                    ${i > 0 ? `<button type="button" class="btn-sm" data-action="split" data-id="${s.id}" data-page="${page}" title="이 페이지부터 별도의 곡으로 나눠요 (콘티 순서는 그대로)">✂ 따로 분리</button>` : ''}
                    <button type="button" class="btn-sm" data-action="remove-page" data-id="${s.id}" data-page="${page}" title="이 페이지만 곡에서 빼요 (PDF 원본은 그대로)">🗑 페이지 빼기</button>
                  </span>
                </figcaption>
              </figure>`;
            }).join('')}
          </div>
        </div>`;
    }).join('')}
    </div>
    ${pending ? `<div class="review-footer">${confirmBtn}</div>` : ''}
    <div class="save-all-bar hidden" id="saveAllBar">
      <span id="saveAllCount"></span>
      <button type="button" class="btn-link" data-action="undo-all">되돌리기</button>
      <button type="button" class="btn-primary" data-action="save-all">💾 전체 저장</button>
    </div>`;
  applyContiView(conti.id);
  updateSaveAllBar();
}

/** 설교 전/후, 느린/빠른 고르기 (같은 줄에서 하나만, 다시 누르면 해제) */
function choiceChip(name, value, label, current) {
  return `<label class="choice-chip choice-${value}"><input type="checkbox" name="${name}" value="${value}"${current === value ? ' checked' : ''} />${label}</label>`;
}

function choiceValue(form, name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

/** "여기부터 설교 후": 앞 곡들은 설교 전, 이 곡부터 끝까지 설교 후 (저장은 전체 저장으로) */
function sectionFromHere(index) {
  const forms = [...document.querySelectorAll('#libModalBody form[data-action-submit="save-song"]')];
  forms.forEach((f, i) => {
    const want = i < index ? 'before' : 'after';
    f.querySelectorAll('input[name="section"]').forEach(c => { c.checked = c.value === want; });
  });
  updateSaveAllBar();
  showToast(`1~${index}번 곡은 설교 전, ${index + 1}번부터 설교 후로 골랐어요. "전체 저장"을 눌러주세요.`, 'info', 4000);
}

const OVERLAP_TEXT = {
  same: '똑같은 콘티',
  inside: '이 콘티가 통째로 들어있는 콘티',
  contains: '이 콘티 안에 통째로 들어있는 콘티',
  partial: '절반 넘게 겹치는 콘티',
};

function overlapBanner(conti) {
  const list = conti.overlaps || [];
  if (!list.length) return '';
  return `<div class="overlap-banner">
    <p class="overlap-title">🔁 겹치는 콘티가 있어요</p>
    ${list.map(o => {
      const name = `"${escapeHtml(o.title)}"${o.conti_date ? ` (${escapeHtml(o.conti_date)})` : ''}`;
      const strong = o.kind !== 'partial';
      return `<div class="overlap-row">
        <span><b>${OVERLAP_TEXT[o.kind]}</b>: ${name} · 같은 페이지 ${o.shared}쪽</span>
        <button type="button" class="btn-sm" data-action="open-conti" data-id="${o.id}">열어보기</button>
        ${!strong ? '' : o.kind === 'contains'
          ? `<button type="button" class="btn-sm danger" data-action="delete-dup" data-id="${o.id}" data-keep="${escapeHtml(conti.title)}" data-here="1">🗑 저 콘티 지우기 (이 콘티만 남김)</button>`
          : `<button type="button" class="btn-sm danger" data-action="delete-dup" data-id="${conti.id}" data-keep="${escapeHtml(o.title)}">🗑 이 콘티 지우기 (저쪽만 남김)</button>`}
      </div>`;
    }).join('')}
    <p class="overlap-sub">같은 악보는 곡 찾기에서 하나로 모아서 보여줘요. 콘티를 지워도 다른 콘티의 악보는 그대로예요.</p>
  </div>`;
}

/* ── 콘티 화면: 여러 곡을 고친 뒤 한 번에 저장 ───────────── */
function fieldChanged(i) {
  return i.type === 'checkbox' || i.type === 'radio' ? i.checked !== i.defaultChecked : i.value !== i.defaultValue;
}

function dirtyContiForms() {
  return [...document.querySelectorAll('#libModalBody form[data-action-submit]')].filter(f =>
    [...f.querySelectorAll('input[name]')].some(fieldChanged));
}

function updateSaveAllBar() {
  const bar = document.getElementById('saveAllBar');
  if (!bar) return;
  document.querySelectorAll('#libModalBody form[data-action-submit]').forEach(f => f.classList.remove('dirty'));
  const dirty = dirtyContiForms();
  dirty.forEach(f => f.classList.add('dirty'));
  bar.classList.toggle('hidden', !dirty.length);
  document.getElementById('saveAllCount').textContent = `✏️ ${dirty.length}곳 수정됨 · 아직 저장 안 됨`;
}

/** 고친 곳을 모두 저장한다. 실패한 곳이 있으면 false. reload=false면 화면은 그대로 둔다. */
async function saveAllConti({ reload = true, quiet = false } = {}) {
  const forms = dirtyContiForms();
  if (!forms.length) return true;
  const btn = document.querySelector('[data-action="save-all"]');
  if (btn) { btn.disabled = true; btn.textContent = '저장하는 중...'; }
  let ok = 0;
  const failed = [];
  for (const f of forms) {   // 하나씩 차례로 (DB에 동시에 몰리지 않게)
    const id = Number(f.dataset.id);
    try {
      if (f.dataset.actionSubmit === 'save-conti') {
        await apiJson(`/api/scores/${id}`, jsonBody('PATCH', {
          title: f.elements.title.value, conti_date: f.elements.conti_date.value,
        }));
      } else {
        const title = f.elements.title.value.trim();
        const key = f.elements.key.value.trim();
        const body = { title, key };
        if (f.querySelector('input[name="section"]')) {
          body.section = choiceValue(f, 'section');
          body.tempo = choiceValue(f, 'tempo');
        }
        await apiJson(`/api/songs/${id}`, jsonBody('PATCH', body));
        updateSetlistItem(id, { title, key });
      }
      [...f.querySelectorAll('input[name]')].forEach(i => { i.defaultValue = i.value; i.defaultChecked = i.checked; });
      ok++;
    } catch (e) {
      failed.push(e.message);
    }
  }
  LibState.modalDirty = true;
  if (failed.length) showToast(`${ok}곳 저장, ${failed.length}곳 실패: ${failed[0]}`, 'error', 6000);
  else if (!quiet) showToast(`${ok}곳 모두 저장했어요.`, 'success');
  if (reload && !failed.length && LibState.modal?.type === 'conti') await reloadContiModal();
  else {
    if (btn) { btn.disabled = false; btn.textContent = '💾 전체 저장'; }
    updateSaveAllBar();
  }
  return !failed.length;
}

function undoAllConti() {
  document.querySelectorAll('#libModalBody form[data-action-submit] input[name]').forEach(i => {
    if (i.type === 'checkbox') i.checked = i.defaultChecked; else i.value = i.defaultValue;
  });
  updateSaveAllBar();
}

async function confirmConti(id) {
  try {
    await apiJson(`/api/scores/${id}/confirm`, jsonBody('POST', { confirmed: true }));
    showToast('확인 완료! 라이브러리에 들어갔어요.', 'success');
    LibState.modalDirty = true;
    const c = LibState.contis.find(x => x.id === id);
    if (c) c.confirmed = true;
    const next = LibState.contis.find(x => !x.confirmed);
    if (next) {
      showToast(`확인할 콘티가 ${LibState.contis.filter(x => !x.confirmed).length}개 더 있어요. 다음 콘티를 열게요.`, 'info', 4000);
      LibState.modal = { type: 'conti', id: next.id, back: null };
      await reloadContiModal();
    } else {
      closeModal();
    }
  } catch (e) {
    showToast('실패: ' + e.message, 'error');
    document.querySelectorAll('[data-action="confirm-conti"]').forEach(b => { b.disabled = false; });
  }
}

/** 팀원(보기 전용)용 콘티 화면: 곡 순서대로 악보만 */
function renderContiModalReadOnly(conti, songs) {
  document.getElementById('libModalBody').innerHTML = `
    <h2 class="lib-modal-title">${escapeHtml(conti.title)}</h2>
    <p class="lib-modal-sub">${conti.conti_date ? `📅 ${escapeHtml(conti.conti_date)} · ` : ''}${songs.length}곡</p>
    ${markPicker(contiMarkKey(conti.id))}
    <div class="now-row"><button type="button" class="btn-now" data-live="send-conti">📡 NOW · 지금 이 콘티 띄우기</button></div>
    ${contiViewBar()}
    <div class="conti-songs-wrap" id="contiSongsWrap">
    ${songs.map((s, i) => `
      ${s.section && s.section !== songs[i - 1]?.section ? `<h3 class="conti-section-head sec-${s.section}">${s.section === 'before' ? '🙏 설교 전 찬양' : '🕊 설교 후 찬양'}</h3>` : ''}
      <div class="conti-song">
        <div class="conti-song-head">
          <span class="conti-song-no">${i + 1}</span>
          <strong class="conti-song-title">${escapeHtml(s.title)}</strong>
          ${s.key ? `<span class="song-key-badge static">${escapeHtml(s.key)}</span>` : ''}
          ${songTags({ tempo: s.tempo })}
          ${addButton(s)}
        </div>
        <div class="song-pages small">${s.image_urls.map(u => `<div class="song-page">${img(u, s.title)}</div>`).join('')}</div>
      </div>`).join('')}
    </div>`;
  applyContiView(conti.id);
}

/* ============================================================
   콘티 안 곡 보기 방식 — 한 줄씩 / 2칸 / 4칸 / 한 곡씩 (기기마다 기억)
   ============================================================ */
const CONTI_VIEWS = [['rows', '☰ 한 줄씩'], ['cols-2', '▦ 2칸'], ['cols-4', '▦ 4칸'], ['one', '1️⃣ 한 곡씩']];
function getContiView() {
  let v = null;
  try { v = localStorage.getItem('jandi.view.conti'); } catch { /* 저장 불가 */ }
  return CONTI_VIEWS.some(x => x[0] === v) ? v : 'rows';
}
function contiViewBar() {
  return `<div class="conti-view-bar" id="contiViewBar">
    <div class="lib-view-toggle" role="group" aria-label="곡 보기 방식">
      ${CONTI_VIEWS.map(([v, label]) => `<button type="button" data-action="conti-view" data-view="${v}">${label}</button>`).join('')}
    </div>
    <div class="conti-one-nav">
      <button type="button" class="btn-sm" data-action="conti-one" data-step="-1">◀ 이전</button>
      <span class="conti-one-pos" id="contiOnePos"></span>
      <button type="button" class="btn-sm" data-action="conti-one" data-step="1">다음 ▶</button>
    </div>
  </div>`;
}
function applyContiView(contiId, view = getContiView()) {
  const wrap = document.getElementById('contiSongsWrap');
  if (!wrap) return;
  if (contiId !== undefined && LibState.contiOne?.id !== contiId) LibState.contiOne = { id: contiId, idx: 0 };
  CONTI_VIEWS.forEach(([v]) => wrap.classList.toggle('view-' + v, v === view));
  document.querySelector('.lib-modal-box')?.classList.toggle('wide', view === 'cols-2' || view === 'cols-4');
  const bar = document.getElementById('contiViewBar');
  bar.classList.toggle('one', view === 'one');
  bar.querySelectorAll('[data-action="conti-view"]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-pressed', b.dataset.view === view);
  });
  showContiOne(0);
}
function showContiOne(step) {
  const wrap = document.getElementById('contiSongsWrap');
  if (!wrap || !LibState.contiOne) return;
  const items = [...wrap.querySelectorAll(':scope > .conti-song')];
  if (!items.length) return;
  const st = LibState.contiOne;
  st.idx = Math.max(0, Math.min(items.length - 1, st.idx + step));
  items.forEach((el, i) => el.classList.toggle('is-current', i === st.idx));
  document.getElementById('contiOnePos').textContent = `${st.idx + 1} / ${items.length}`;
  const bar = document.getElementById('contiViewBar');
  bar.querySelector('[data-step="-1"]').disabled = st.idx === 0;
  bar.querySelector('[data-step="1"]').disabled = st.idx === items.length - 1;
  if (step && wrap.classList.contains('view-one')) bar.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function contiAction(makeRequest, okMsg) {
  // 곡 나누기·빼기 등은 화면을 다시 그리므로, 먼저 고쳐 둔 제목·키를 저장한다
  if (!(await saveAllConti({ reload: false, quiet: true }))) return;
  try {
    await makeRequest();
    if (okMsg) showToast(okMsg, 'success');
    LibState.modalDirty = true;
    await reloadContiModal();
  } catch (e) {
    showToast('실패: ' + e.message, 'error');
  }
}

/* ============================================================
   모달 열고 닫기
   ============================================================ */
function showModal() {
  document.querySelector('.lib-modal-box')?.classList.remove('wide');
  document.getElementById('libModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal(force = false) {
  if (!force && LibState.modal?.type === 'conti') {
    const n = dirtyContiForms().length;
    if (n) {
      if (confirm(`저장 안 한 수정이 ${n}곳 있어요. 저장하고 닫을까요?\n(취소를 누르면 수정한 내용 없이 닫혀요)`)) {
        saveAllConti({ reload: false }).then(ok => { if (ok) closeModal(true); });
        return;
      }
    }
  }
  clearTimeout(LibState.modalPoll);
  document.getElementById('libModal').classList.add('hidden');
  document.querySelector('.lib-modal-box')?.classList.remove('wide');
  document.body.classList.remove('modal-open');
  LibState.modal = null;
  if (LibState.modalDirty) {
    LibState.modalDirty = false;
    refreshAll();
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && LibState.modal) closeModal();
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && LibState.modal?.type === 'conti'
      && document.getElementById('contiSongsWrap')?.classList.contains('view-one')
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    showContiOne(e.key === 'ArrowLeft' ? -1 : 1);
  }
});

/* ============================================================
   이벤트 위임
   ============================================================ */
function initDelegatedActions() {
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'FORM') return;
    const id = Number(el.dataset.id);
    switch (el.dataset.action) {
      case 'open-song': openSongModal(el.dataset.group); break;
      case 'open-conti': openContiModal(id); break;
      case 'modal-back':
        if (LibState.modal?.back) {
          LibState.modal = LibState.modal.back;
          renderSongModal();
          document.querySelector('.lib-modal')?.scrollTo(0, 0);
        }
        break;
      case 'toggle-set': e.preventDefault(); toggleSetlist(id); break;
      case 'cat-filter': {
        const k = el.dataset.kind === 'section' ? 'selectedSection' : 'selectedTempo';
        LibState[k] = LibState[k] === el.dataset.val ? null : el.dataset.val;
        if (LibState.tab !== 'songs') switchTab('songs');
        renderCategoryChips();
        fetchSongs();
        break;
      }
      case 'set-group-tempo': setGroupTempo(el.dataset.tempo); break;
      case 'keep-sheet': keepSheet(id, el.dataset.ids.split(',').map(Number), el.dataset.key); break;
      case 'restore-sheet':
        if (await saveAllConti({ reload: false, quiet: true })) restoreSheet(id);
        break;
      case 'from-here-after': sectionFromHere(Number(el.dataset.index)); break;
      case 'key-all': LibState.selectedKeys.clear(); renderKeyChips(); fetchSongs(); break;
      case 'mark-filter':
        LibState.selectedMark = el.dataset.mark && LibState.selectedMark !== el.dataset.mark ? el.dataset.mark : null;
        if (LibState.tab !== 'songs') switchTab('songs');
        renderMarkChips();
        renderSongs();
        break;
      case 'toggle-song-mark': toggleSongMark(el.dataset.group, el.dataset.mark); break;
      case 'conti-cat':
        LibState.contiCat = el.dataset.val && LibState.contiCat !== el.dataset.val ? el.dataset.val : null;
        renderContis();
        break;
      case 'conti-mark-filter':
        LibState.contiMark = el.dataset.mark && LibState.contiMark !== el.dataset.mark ? el.dataset.mark : null;
        renderContis();
        break;
      case 'conti-mark-open':
        LibState.contiMarkOpen = LibState.contiMarkOpen === id ? null : id;
        renderContis();
        break;
      case 'toggle-key': toggleIn(LibState.selectedKeys, el.dataset.key); renderKeyChips(); fetchSongs(); break;
      case 'toggle-chord': toggleIn(LibState.selectedChords, el.dataset.chord); renderChordChips(); fetchSongs(); break;
      case 'edit-song': document.getElementById(`songEdit-${id}`)?.classList.toggle('hidden'); break;
      case 'add-conti': addContiToSetlist(id); break;
      case 'delete-conti': deleteConti(id); break;
      case 'delete-dup':
        if (await deleteConti(id, `"${el.dataset.keep}"`)) {
          if (el.dataset.here) await reloadContiModal(); else closeModal(true);
        }
        break;
      case 'merge-prev':
        e.preventDefault();
        contiAction(() => apiJson(`/api/songs/${id}/merge-prev`, { method: 'POST' }), '앞 곡과 합쳤어요');
        break;
      case 'split':
        contiAction(() => apiJson(`/api/songs/${id}/split`, jsonBody('POST', { page: Number(el.dataset.page) })), '따로 분리했어요 — 새 곡의 제목·키를 확인해주세요');
        break;
      case 'remove-page':
        contiAction(() => apiJson(`/api/songs/${id}/remove-page`, jsonBody('POST', { page: Number(el.dataset.page) })),
          `p.${el.dataset.page}를 뺐어요 (다시 넣으려면 "＋ 곡으로 추가")`);
        break;
      case 'confirm-conti':
        el.disabled = true;
        if (await saveAllConti({ reload: false, quiet: true })) confirmConti(id);
        else el.disabled = false;
        break;
      case 'save-all': saveAllConti(); break;
      case 'undo-all': undoAllConti(); break;
      case 'conti-view':
        try { localStorage.setItem('jandi.view.conti', el.dataset.view); } catch { /* 저장 불가 */ }
        applyContiView(undefined, el.dataset.view);
        break;
      case 'conti-one': showContiOne(Number(el.dataset.step)); break;
      case 'review-next': {
        const next = LibState.contis.find(x => !x.confirmed);
        if (next) openContiModal(next.id);
        break;
      }
      case 'delete-song':
        e.preventDefault();
        removeFromSetlist(id);
        contiAction(() => apiJson(`/api/songs/${id}`, { method: 'DELETE' }), '곡 목록에서 뺐어요 (PDF 원본은 그대로예요)');
        break;
      case 'add-page-song': {
        const page = Number(el.dataset.page);
        contiAction(() => apiJson(`/api/scores/${el.dataset.score}/songs`, jsonBody('POST', { page_start: page, page_end: page })), '곡으로 추가했어요');
        break;
      }
      case 'reprocess':
        if (!confirm('이 콘티를 처음부터 다시 분석할까요? 직접 고친 제목·키·곡 나누기는 사라져요.')) return;
        el.disabled = true;
        contiAction(() => isPhpServer() ? clientReprocess(id) : apiJson(`/api/scores/${id}/reprocess`, { method: 'POST' }),
          isPhpServer() ? '다시 읽기를 시작했어요 — 끝날 때까지 이 창을 닫지 마세요' : '다시 분석을 시작했어요');
        break;
      case 'reprocess-ai':
        if (!confirm('Claude AI로 이 콘티를 다시 읽을까요?\n· 직접 고친 제목·키·곡 나누기는 사라져요\n· 페이지마다 Claude API 사용료가 들어요')) return;
        el.disabled = true;
        contiAction(() => apiJson(`/api/scores/${id}/reprocess?engine=ai`, { method: 'POST' }), 'AI 인식을 시작했어요');
        break;
      case 'setlist-up': moveSetlistItem(Number(el.dataset.index), -1); break;
      case 'setlist-down': moveSetlistItem(Number(el.dataset.index), 1); break;
      case 'setlist-remove': removeFromSetlist(id); break;
    }
  });

  document.addEventListener('submit', e => {
    const form = e.target.closest('form[data-action-submit]');
    if (!form) return;
    e.preventDefault();
    const id = Number(form.dataset.id);
    if (LibState.modal?.type === 'conti' && form.closest('#libModalBody') && document.getElementById('saveAllBar')) {
      saveAllConti();
      return;
    }
    if (form.dataset.actionSubmit === 'save-song') saveSong(id, form);
    if (form.dataset.actionSubmit === 'save-conti') saveConti(id, form);
  });
  document.addEventListener('input', e => {
    if (e.target.closest('#libModalBody form[data-action-submit]')) updateSaveAllBar();
  });
  document.addEventListener('change', e => {
    const c = e.target;
    if (c.type !== 'checkbox' || !c.closest('.song-cats')) return;
    if (c.checked) c.form.querySelectorAll(`input[name="${c.name}"]`).forEach(o => { if (o !== c) o.checked = false; });
    updateSaveAllBar();
  });
}

function toggleIn(set, v) {
  if (set.has(v)) set.delete(v); else set.add(v);
}

async function saveConti(id, form) {
  try {
    await apiJson(`/api/scores/${id}`, jsonBody('PATCH', {
      title: form.elements.title.value, conti_date: form.elements.conti_date.value,
    }));
    showToast('콘티 정보를 저장했어요.', 'success');
    LibState.modalDirty = true;
  } catch (e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}

async function deleteConti(id, keepName = '') {
  const c = LibState.contis.find(x => x.id === id);
  const keep = keepName ? `\n${keepName} 콘티와 그 악보는 그대로 남아요.` : '';
  if (!confirm(`"${c ? c.title : '이 콘티'}"를 삭제할까요? 이 콘티에 한 필기도 함께 삭제돼요.${keep}`)) return false;
  try {
    await apiJson(`/api/scores/${id}`, { method: 'DELETE' });
    if (c) c.songs.forEach(s => removeFromSetlist(s.id, false));
    renderSetlist();
    showToast('삭제했어요.', 'info');
    refreshAll();
    return true;
  } catch (e) {
    showToast('삭제 실패: ' + e.message, 'error');
    return false;
  }
}

/* ============================================================
   업로드 (여러 파일, 드래그 앤 드롭)
   ============================================================ */
function initUpload() {
  const input = document.getElementById('libraryFileInput');
  input.addEventListener('change', () => {
    uploadFiles([...input.files]);
    input.value = '';
  });

  const zone = document.getElementById('dropzone');
  const box = document.getElementById('dropbox');
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const hide = () => { depth = 0; zone.classList.add('hidden'); box?.classList.remove('drag-over'); };
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e) || !AuthState.canEdit) return;
    depth++;
    zone.classList.remove('hidden');
    box?.classList.add('drag-over');
  });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) hide(); });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();  // 이게 없으면 브라우저가 PDF를 새 창으로 열어버린다
    e.dataTransfer.dropEffect = AuthState.canEdit ? 'copy' : 'none';
  });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (!AuthState.canEdit) { showToast('업로드는 관리자만 할 수 있어요.', 'info'); return; }
    uploadFiles(await filesFromDrop(e.dataTransfer));
  });
}

/* 끌어다 놓은 것에서 파일을 모은다 — 폴더를 놓으면 안에 든 파일까지 (하위 폴더 포함) */
async function filesFromDrop(dt) {
  // entry는 drop 이벤트 안에서 바로 꺼내야 한다 (await 뒤에는 dataTransfer가 비워짐)
  const entries = [...(dt.items || [])]
    .filter(it => it.kind === 'file')
    .map(it => it.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length || !entries.some(en => en.isDirectory)) return [...dt.files];

  const out = [];
  const readEntry = async en => {
    if (en.isFile) {
      out.push(await new Promise((res, rej) => en.file(res, rej)));
    } else if (en.isDirectory) {
      const reader = en.createReader();
      for (;;) {  // readEntries는 한 번에 일부만 주므로 빌 때까지 반복
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await readEntry(child);
      }
    }
  };
  for (const en of entries) {
    try { await readEntry(en); } catch (err) { console.error(err); }
  }
  return out;
}

const isPdfFile = f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf';

/* 업로드 대기열 — 올리는 중에 또 끌어다 놓아도 차례대로 처리한다 */
const UploadQueue = { items: [], running: false };

function uploadFiles(files) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });
  const pdfs = files.filter(isPdfFile).sort(byName);
  const images = files.filter(f => !isPdfFile(f) && isImageFile(f)).sort(byName);
  const skipped = files.length - pdfs.length - images.length;
  if (!pdfs.length && !images.length) {
    if (files.length) showToast('PDF나 사진(JPG·PNG)만 올릴 수 있어요.', 'error');
    return;
  }
  if (skipped) showToast(`PDF·사진이 아닌 파일 ${skipped}개는 건너뛰었어요.`, 'info');
  pdfs.forEach(f => UploadQueue.items.push({ file: f, status: 'wait', note: '' }));
  if (images.length) {
    if (!isPhpServer()) {
      showToast('사진 올리기는 카페24 서버에서만 돼요. PDF로 올려주세요.', 'error');
    } else {
      // 한 번에 고른 사진들 = 콘티 하나 (사진 한 장 = 한 쪽)
      const d = new Date();
      const label = `사진 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        + (images.length > 1 ? ` (${images.length}장)` : '');
      UploadQueue.items.push({ file: { name: label }, images, status: 'wait', note: '' });
    }
  }
  if (!UploadQueue.items.length) return;
  renderUploadList();
  if (!UploadQueue.running) runUploadQueue();
}

/** 서버가 백그라운드에서 분석을 끝낼 때까지 몇 초마다 확인한다 */
async function waitForAnalysis(conti, onProgress) {
  let c = conti;
  while (c.status === 'processing') {
    onProgress?.(c.status_detail || '분석 중');
    await new Promise(r => setTimeout(r, 3000));
    try {
      c = await apiJson(`/api/scores/${c.id}`);
    } catch (e) {
      onProgress?.('연결 확인 중...');  // 잠깐 끊겨도 계속 기다린다
    }
  }
  return c;
}

const UPLOAD_STATUS = {
  wait: ['⏳', '대기'], work: ['🔄', '분석 중'], ok: ['✅', ''], dup: ['↩️', '이미 있는 콘티'], fail: ['❌', '실패'],
};

function renderUploadList() {
  const items = UploadQueue.items;
  const done = items.filter(it => !['wait', 'work'].includes(it.status)).length;
  const cur = items.find(it => it.status === 'work');
  document.getElementById('uploadProgressTitle').textContent = items.length > 1
    ? `콘티 ${items.length}개 중 ${done}개 완료${cur ? ` — "${cur.file.name}" 처리하는 중...` : ''}`
    : `"${items[0]?.file.name || ''}" 처리하는 중... ${items[0]?.note || ''}`;
  document.getElementById('uploadFileList').innerHTML = items.length > 1
    ? items.map(it => {
        const [icon, label] = UPLOAD_STATUS[it.status];
        return `<li class="up-${it.status}">${icon} <span class="up-name">${escapeHtml(it.file.name)}</span>
          <span class="up-note">${escapeHtml(it.note || label)}</span></li>`;
      }).join('')
    : '';
}

async function runUploadQueue() {
  UploadQueue.running = true;
  const progress = document.getElementById('uploadProgress');
  const btn = document.getElementById('uploadTriggerBtn');
  progress.classList.remove('hidden');
  btn.disabled = true;

  let it;
  while ((it = UploadQueue.items.find(x => x.status === 'wait'))) {
    it.status = 'work';
    renderUploadList();
    try {
      let conti;
      if (it.images) {
        conti = await clientUploadImages(it.images, it.file.name, detail => { it.note = detail; renderUploadList(); });
      } else if (isPhpServer()) {
        // 카페24: 브라우저가 페이지를 그림으로 바꿔 올리고, 서버가 한 장씩 읽는다
        conti = await clientUploadPdf(it.file, detail => { it.note = detail; renderUploadList(); });
      } else {
        const fd = new FormData();
        fd.append('file', it.file);
        conti = await apiJson('/api/scores', { method: 'POST', body: fd });
      }
      if (conti.duplicate) {
        it.conti = conti;
        it.status = 'dup';
      } else {
        if (conti.status === 'processing') {
          it.note = '올리기 완료 — 분석 시작';
          renderUploadList();
          conti = await waitForAnalysis(conti, detail => { it.note = detail; renderUploadList(); });
        }
        it.conti = conti;
        if (conti.status === 'error') throw new Error(conti.status_detail || '분석 실패');
        it.status = 'ok';
        it.note = `곡 ${conti.songs.length}개`;
        if (conti.unread) {
          it.note += ` · AI가 못 읽은 사진 ${conti.unread}장`;
          showToast(`AI가 사진 ${conti.unread}장을 못 읽었어요. 콘티 화면에서 '제목 없음' 곡의 제목과 키를 직접 적어주세요.`, 'info', 8000);
        }
      }
    } catch (e) {
      console.error(e);
      it.status = 'fail';
      it.note = e.message;
    }
    renderUploadList();
  }

  const items = UploadQueue.items;
  UploadQueue.items = [];
  UploadQueue.running = false;
  progress.classList.add('hidden');
  btn.disabled = false;

  const ok = items.filter(x => x.status === 'ok');
  const dupes = items.filter(x => x.status === 'dup');
  const songCount = ok.reduce((n, x) => n + x.conti.songs.length, 0);
  if (ok.length) showToast(`콘티 ${ok.length}개 업로드 완료 — 곡 ${songCount}개를 찾았어요. 확인 후 '확인 완료'를 누르면 라이브러리에 들어가요.`, 'success', 6000);
  if (dupes.length) showToast(`이미 올린 콘티라서 다시 저장하지 않았어요: ${dupes.map(x => x.file.name).join(', ')}`, 'info', 6000);
  items.filter(x => x.status === 'fail').forEach(x => showToast(`업로드 실패: ${x.file.name}: ${x.note}`, 'error', 7000));

  resetFilters();
  LibState.tab = 'contis';
  await refreshAll();
  // 올린 콘티를 바로 확인 화면으로 연다 (여러 개면 첫 번째부터, 확인 완료를 누르면 다음 것으로)
  const firstNew = ok[0]?.conti || (items.length === 1 ? items[0].conti : null);
  if (firstNew) openContiModal(firstNew.id);
}

/* ============================================================
   새 콘티 (선택한 곡 목록) — localStorage에 유지
   ============================================================ */
function loadSetlist() {
  try {
    const v = JSON.parse(localStorage.getItem(SETLIST_STORAGE_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveSetlist() {
  try { localStorage.setItem(SETLIST_STORAGE_KEY, JSON.stringify(LibState.setlist)); } catch { /* 저장 불가 환경 */ }
}

function findSongAnywhere(id) {
  for (const g of LibState.groups) {
    const v = g.versions.find(s => s.id === id);
    if (v) return v;
  }
  return (LibState.modal?.songs || []).find(s => s.id === id);
}

function toSetlistItem(s) {
  return { id: s.id, title: s.title, key: s.key, conti_date: s.conti_date, conti_title: s.conti_title, image: s.image_urls[0] };
}

async function toggleSetlist(id) {
  if (inSetlist(id)) {
    removeFromSetlist(id);
    return;
  }
  let s = findSongAnywhere(id);
  if (!s) {
    try { s = await apiJson(`/api/songs/${id}`); } catch (e) { showToast('곡을 찾을 수 없어요', 'error'); return; }
  }
  LibState.setlist.push(toSetlistItem(s));
  afterSetlistChange();
}

async function addContiToSetlist(contiId) {
  try {
    const songs = (await apiJson(`/api/songs?score_id=${contiId}`)).sort((a, b) => a.page_start - b.page_start);
    let added = 0;
    for (const s of songs) {
      if (!inSetlist(s.id)) { LibState.setlist.push(toSetlistItem(s)); added++; }
    }
    afterSetlistChange();
    showToast(`${added}곡을 새 콘티에 담았어요.`, 'success');
  } catch (e) {
    showToast('실패: ' + e.message, 'error');
  }
}

function removeFromSetlist(id, rerender = true) {
  LibState.setlist = LibState.setlist.filter(s => s.id !== id);
  if (rerender) afterSetlistChange();
  else saveSetlist();
}

function updateSetlistItem(id, patch) {
  const item = LibState.setlist.find(s => s.id === id);
  if (item) { Object.assign(item, patch); saveSetlist(); renderSetlist(); }
}

function moveSetlistItem(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= LibState.setlist.length) return;
  const list = LibState.setlist;
  [list[index], list[j]] = [list[j], list[index]];
  afterSetlistChange();
}

function clearSetlist() {
  if (!LibState.setlist.length || !confirm('담은 곡을 모두 비울까요?')) return;
  LibState.setlist = [];
  afterSetlistChange();
}

function afterSetlistChange() {
  saveSetlist();
  renderSetlist();
  // 담기 버튼 상태 갱신 (화면 전체 다시 그리지 않고 버튼만)
  document.querySelectorAll('.song-add-btn[data-id]').forEach(b => {
    const on = inSetlist(Number(b.dataset.id));
    b.classList.toggle('on', on);
    b.textContent = on ? '✓ 담김' : '＋ 콘티에 담기';
  });
}

function toggleSetlistPanel(force) {
  const panel = document.getElementById('setlistPanel');
  const open = force ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  document.getElementById('setlistToggle').textContent = open ? '▼' : '▲';
}

function renderSetlist() {
  const tray = document.getElementById('setlistTray');
  const list = LibState.setlist;
  tray.classList.toggle('hidden', list.length === 0);
  document.body.classList.toggle('has-setlist', list.length > 0);
  document.getElementById('setlistCount').textContent = list.length;
  document.getElementById('setlistKeys').textContent = list.map(s => s.key || '?').join(' → ');

  const titleInput = document.getElementById('setlistTitle');
  if (!titleInput.value) titleInput.value = nextSundayLabel();

  document.getElementById('setlistItems').innerHTML = list.map((s, i) => `
    <li class="setlist-item" draggable="true" data-index="${i}">
      <span class="setlist-no">${i + 1}</span>
      <div class="setlist-thumb">${img(s.image, s.title)}</div>
      <div class="setlist-info">
        <strong>${escapeHtml(s.title)}</strong>
        <span>${s.key ? `<b>${escapeHtml(s.key)}</b> · ` : ''}${escapeHtml(s.conti_date || s.conti_title || '')}</span>
      </div>
      <div class="setlist-item-actions">
        <button class="btn-sm" data-action="setlist-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} aria-label="위로">↑</button>
        <button class="btn-sm" data-action="setlist-down" data-index="${i}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="아래로">↓</button>
        <button class="btn-sm" data-action="setlist-remove" data-id="${s.id}" aria-label="빼기">×</button>
      </div>
    </li>`).join('');
  initSetlistDrag();
}

function initSetlistDrag() {
  let from = null;
  document.querySelectorAll('.setlist-item').forEach(li => {
    li.addEventListener('dragstart', () => { from = Number(li.dataset.index); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', e => e.preventDefault());
    li.addEventListener('drop', e => {
      e.preventDefault();
      const to = Number(li.dataset.index);
      if (from === null || from === to) return;
      const [item] = LibState.setlist.splice(from, 1);
      LibState.setlist.splice(to, 0, item);
      from = null;
      afterSetlistChange();
    });
  });
}

/** 새 콘티를 라이브러리에 콘티로 저장 (관리자) — 악보 그림을 복사해서 '콘티 목록'에 들어간다 */
async function saveSetlistToLibrary() {
  if (!LibState.setlist.length) return;
  const btn = document.getElementById('setlistSaveBtn');
  const title = document.getElementById('setlistTitle').value.trim() || nextSundayLabel();
  if (!confirm(`"${title}" (${LibState.setlist.length}곡)을 라이브러리 콘티 목록에 저장할까요?`)) return;
  btn.disabled = true;
  btn.textContent = '저장 중...';
  try {
    const conti = await apiJson('/api/setlist/save', jsonBody('POST', {
      song_ids: LibState.setlist.map(s => s.id),
      title,
      include_annotations: document.getElementById('setlistAnnot').checked,
    }));
    showToast(`"${conti.title}"을 콘티 목록에 저장했어요 (${conti.page_count}쪽).`, 'success', 5000);
    await refreshAll();
    openContiModal(conti.id);
  } catch (e) {
    showToast('저장 실패: ' + e.message, 'error');
    if (/찾을 수 없습니다/.test(e.message)) showToast('삭제된 곡이 목록에 남아 있어요. × 로 빼주세요.', 'warning', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 라이브러리에 저장';
  }
}

async function exportSetlist() {
  if (!LibState.setlist.length) return;
  const btn = document.getElementById('setlistExportBtn');
  const title = document.getElementById('setlistTitle').value.trim() || nextSundayLabel();
  btn.disabled = true;
  btn.textContent = '만드는 중...';
  try {
    const res = await fetch(`${API_BASE}/api/setlist/export`, jsonBody('POST', {
      song_ids: LibState.setlist.map(s => s.id),
      title,
      include_annotations: document.getElementById('setlistAnnot').checked,
    }));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const how = await saveOrShareFile(blob, `${title.replace(/[\\/:*?"<>|]/g, '')}.pdf`);
    if (how !== 'cancelled') showToast(`"${title}.pdf" 를 내보냈어요 (${LibState.setlist.length}곡).`, 'success');
  } catch (e) {
    showToast('내보내기 실패: ' + e.message, 'error');
    // 삭제된 곡이 남아있으면 내보내기가 실패하므로 정리할 수 있게 안내
    if (/찾을 수 없습니다/.test(e.message)) showToast('삭제된 곡이 목록에 남아 있어요. × 로 빼주세요.', 'warning', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇️ PDF 내보내기';
  }
}
