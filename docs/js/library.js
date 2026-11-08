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
};

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
  document.getElementById('libraryOffline').classList.add('hidden');
  switchTab(LibState.tab);
  try {
    document.getElementById('songsTabCount').textContent = facets.total ? `(${facets.total})` : '';
    document.getElementById('contisTabCount').textContent = contis.length ? `(${contis.length})` : '';
    renderKeyChips();
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
  try {
    const songs = await apiJson(`/api/songs?${params}`);
    LibState.groups = groupSongs(songs);
    LibState.groupsById = new Map(LibState.groups.map(g => [g.key, g]));
    renderSongs();
  } catch (e) {
    console.warn('검색 실패:', e);
  }
}

/** 같은 곡(제목이 같은 것)이 여러 콘티에 들어있으면 카드 하나로 묶는다. */
function groupSongs(songs) {
  const map = new Map();
  for (const s of songs) {
    const k = normTitle(s.title) || `__song${s.id}`;
    if (!map.has(k)) map.set(k, { key: k, versions: [] });
    map.get(k).versions.push(s);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.versions.sort((a, b) => String(b.conti_date || '').localeCompare(String(a.conti_date || '')) || b.id - a.id);
    g.main = g.versions[0];
    g.keys = [...new Set(g.versions.map(v => v.key).filter(Boolean))].sort((a, b) => keySortIndex(a) - keySortIndex(b));
  }
  return groups;
}

/* ============================================================
   탭 / 검색 / 필터
   ============================================================ */
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
  const total = LibState.groups.reduce((n, g) => n + g.versions.length, 0);
  document.getElementById('songsCount').textContent =
    LibState.groups.length ? `${LibState.groups.length}곡 (악보 ${total}장)` : '';

  if (!LibState.groups.length) {
    grid.innerHTML = '';
    const filtered = LibState.q || LibState.selectedKeys.size || LibState.selectedChords.size;
    document.getElementById('songsEmptyTitle').textContent = filtered ? '조건에 맞는 곡이 없어요' : '아직 업로드한 콘티가 없어요';
    document.getElementById('songsEmptySub').textContent = filtered ? '검색어나 키 필터를 바꿔보세요' : '위의 "콘티 PDF 업로드" 버튼으로 PDF를 올려보세요';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = LibState.groups.map(renderSongCard).join('');
}

function inSetlist(songId) {
  return LibState.setlist.some(s => s.id === songId);
}

function addButton(song, extraCls = '') {
  const on = inSetlist(song.id);
  return `<button type="button" class="song-add-btn${on ? ' on' : ''} ${extraCls}" data-action="toggle-set" data-id="${song.id}">
    ${on ? '✓ 담김' : '＋ 콘티에 담기'}</button>`;
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
        <p class="lib-card-title" data-action="open-song" data-group="${escapeHtml(g.key)}">${escapeHtml(s.title)}</p>
        <p class="song-meta">${meta}</p>
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
    const all = await apiJson(`/api/songs?q=${encodeURIComponent(modal.title)}`);
    const versions = all.filter(s => normTitle(s.title) === target);
    if (versions.length && LibState.modal === modal) {
      modal.versions = sortVersions(versions);
      renderSongModal();
    }
  } catch (e) {
    console.warn('곡 버전 불러오기 실패:', e);
  }
}

function renderSongModal() {
  const m = LibState.modal;
  const versions = m.versions || [];
  if (!versions.length) { closeModal(); return; }
  const contiCount = new Set(versions.map(v => v.score_id)).size;
  document.getElementById('libModalBody').innerHTML = `
    <h2 class="lib-modal-title">${escapeHtml(versions[0].title)}</h2>
    <p class="lib-modal-sub">${contiCount > 1 ? `${contiCount}개 콘티에서 사용했어요` : '1개 콘티에서 사용했어요'}</p>
    ${renderSongContis(versions)}
    <h3 class="song-section-title">🎼 악보 <span>${versions.length}</span></h3>
    ${versions.map(renderSongVersion).join('')}`;
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

function renderSongVersion(s) {
  const range = s.page_start === s.page_end ? `p.${s.page_start}` : `p.${s.page_start}–${s.page_end}`;
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
          ${addButton(s)}
          <button class="btn-sm admin-only" data-action="edit-song" data-id="${s.id}">✏️ 수정</button>
          <a class="btn-sm" href="viewer.html?id=${s.score_id}&page=${s.page_start}">✍️ 필기</a>
        </div>
      </div>
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
function renderContis() {
  const list = document.getElementById('contiList');
  const empty = document.getElementById('contisEmpty');
  if (!LibState.contis.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = LibState.contis.map(c => `
    <div class="conti-row">
      <div class="conti-thumb lib-card-thumb" data-action="open-conti" data-id="${c.id}">${img(c.thumbnail_url, c.title)}</div>
      <div class="conti-info">
        <p class="conti-title" data-action="open-conti" data-id="${c.id}">${escapeHtml(c.title)}</p>
        <p class="song-meta">${c.conti_date ? `📅 ${escapeHtml(c.conti_date)} · ` : ''}${c.songs.length}곡 · ${c.page_count}페이지</p>
        <div class="conti-songs">
          ${c.songs.map((s, i) => `<span class="conti-song-chip">${i + 1}. ${escapeHtml(s.title)}${s.key ? ` <b>${escapeHtml(s.key)}</b>` : ''}</span>`).join('')
            || '<span class="lib-card-nochords">곡이 없어요 — "곡 나누기·수정"에서 분석해주세요</span>'}
        </div>
      </div>
      <div class="conti-actions">
        <button class="btn-sm" data-action="open-conti" data-id="${c.id}">${AuthState.canEdit ? '🧩 곡 나누기·수정' : '📄 악보 보기'}</button>
        <button class="btn-sm" data-action="add-conti" data-id="${c.id}">＋ 전체 담기</button>
        <a class="btn-sm" href="viewer.html?id=${c.id}">✍️ 필기</a>
        <button class="btn-sm admin-only" data-action="delete-conti" data-id="${c.id}">🗑️</button>
      </div>
    </div>`).join('');
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
    closeModal();
  }
}

function renderContiModal(conti, songs) {
  songs.sort((a, b) => a.page_start - b.page_start);
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

  document.getElementById('libModalBody').innerHTML = `
    <form class="conti-edit-head" data-action-submit="save-conti" data-id="${conti.id}">
      <input type="text" name="title" class="lib-edit-title-input conti-title-input" value="${escapeHtml(conti.title)}" />
      <input type="date" name="conti_date" class="lib-edit-title-input" value="${escapeHtml(conti.conti_date || '')}" />
      <button type="submit" class="btn-primary btn-compact">저장</button>
    </form>
    <p class="lib-modal-sub">
      자동으로 나눈 곡이 틀렸다면 여기서 고쳐주세요. 표지·순서지 페이지는 "곡에서 빼기"를 누르면 검색에 안 나와요.
      <button class="btn-link" data-action="reprocess" data-id="${conti.id}">처음부터 다시 분석</button>
    </p>
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
            <button type="submit" class="btn-sm">저장</button>
            ${isFirst ? '' : `<button type="button" class="btn-sm" data-action="merge-prev" data-id="${s.id}" title="앞 곡의 다음 페이지로 합치기">⤴ 앞 곡과 합치기</button>`}
            <button type="button" class="btn-sm" data-action="delete-song" data-id="${s.id}">곡에서 빼기</button>
            ${addButton(s)}
          </form>
          ${suspicious ? '<p class="conti-hint">코드와 키를 찾지 못했어요. 표지·순서지라면 "곡에서 빼기"를 눌러주세요.</p>' : ''}
          <div class="song-pages small">
            ${s.image_urls.map((u, i) => {
              const page = s.page_start + i;
              return `<figure class="song-page">${img(u, s.title)}
                <figcaption>p.${page}${i > 0 ? ` <button class="btn-link" data-action="split" data-id="${s.id}" data-page="${page}">✂ 여기부터 새 곡</button>` : ''}</figcaption>
              </figure>`;
            }).join('')}
          </div>
        </div>`;
    }).join('')}`;
}

/** 팀원(보기 전용)용 콘티 화면: 곡 순서대로 악보만 */
function renderContiModalReadOnly(conti, songs) {
  document.getElementById('libModalBody').innerHTML = `
    <h2 class="lib-modal-title">${escapeHtml(conti.title)}</h2>
    <p class="lib-modal-sub">${conti.conti_date ? `📅 ${escapeHtml(conti.conti_date)} · ` : ''}${songs.length}곡</p>
    ${songs.map((s, i) => `
      <div class="conti-song">
        <div class="conti-song-head">
          <span class="conti-song-no">${i + 1}</span>
          <strong class="conti-song-title">${escapeHtml(s.title)}</strong>
          ${s.key ? `<span class="song-key-badge static">${escapeHtml(s.key)}</span>` : ''}
          ${addButton(s)}
        </div>
        <div class="song-pages small">${s.image_urls.map(u => `<div class="song-page">${img(u, s.title)}</div>`).join('')}</div>
      </div>`).join('')}`;
}

async function contiAction(promise, okMsg) {
  try {
    await promise;
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
  document.getElementById('libModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal() {
  document.getElementById('libModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  LibState.modal = null;
  if (LibState.modalDirty) {
    LibState.modalDirty = false;
    refreshAll();
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && LibState.modal) closeModal();
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
      case 'key-all': LibState.selectedKeys.clear(); renderKeyChips(); fetchSongs(); break;
      case 'toggle-key': toggleIn(LibState.selectedKeys, el.dataset.key); renderKeyChips(); fetchSongs(); break;
      case 'toggle-chord': toggleIn(LibState.selectedChords, el.dataset.chord); renderChordChips(); fetchSongs(); break;
      case 'edit-song': document.getElementById(`songEdit-${id}`)?.classList.toggle('hidden'); break;
      case 'add-conti': addContiToSetlist(id); break;
      case 'delete-conti': deleteConti(id); break;
      case 'merge-prev':
        e.preventDefault();
        contiAction(apiJson(`/api/songs/${id}/merge-prev`, { method: 'POST' }), '앞 곡과 합쳤어요');
        break;
      case 'split':
        contiAction(apiJson(`/api/songs/${id}/split`, jsonBody('POST', { page: Number(el.dataset.page) })), '새 곡으로 나눴어요');
        break;
      case 'delete-song':
        e.preventDefault();
        removeFromSetlist(id);
        contiAction(apiJson(`/api/songs/${id}`, { method: 'DELETE' }), '곡 목록에서 뺐어요 (PDF 원본은 그대로예요)');
        break;
      case 'add-page-song': {
        const page = Number(el.dataset.page);
        contiAction(apiJson(`/api/scores/${el.dataset.score}/songs`, jsonBody('POST', { page_start: page, page_end: page })), '곡으로 추가했어요');
        break;
      }
      case 'reprocess':
        if (!confirm('이 콘티를 처음부터 다시 분석할까요? 직접 고친 제목·키·곡 나누기는 사라져요.')) return;
        el.disabled = true;
        el.textContent = '분석 중...';
        contiAction(apiJson(`/api/scores/${id}/reprocess`, { method: 'POST' }), '다시 분석했어요');
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
    if (form.dataset.actionSubmit === 'save-song') saveSong(id, form);
    if (form.dataset.actionSubmit === 'save-conti') saveConti(id, form);
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

async function deleteConti(id) {
  const c = LibState.contis.find(x => x.id === id);
  if (!confirm(`"${c ? c.title : '이 콘티'}"를 삭제할까요? 안에 있는 곡 악보와 필기도 함께 삭제돼요.`)) return;
  try {
    await apiJson(`/api/scores/${id}`, { method: 'DELETE' });
    if (c) c.songs.forEach(s => removeFromSetlist(s.id, false));
    renderSetlist();
    showToast('삭제했어요.', 'info');
    refreshAll();
  } catch (e) {
    showToast('삭제 실패: ' + e.message, 'error');
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
  const pdfs = files.filter(isPdfFile)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  const skipped = files.length - pdfs.length;
  if (!pdfs.length) {
    if (files.length) showToast('PDF 파일만 업로드할 수 있어요.', 'error');
    return;
  }
  if (skipped) showToast(`PDF가 아닌 파일 ${skipped}개는 건너뛰었어요.`, 'info');
  pdfs.forEach(f => UploadQueue.items.push({ file: f, status: 'wait', note: '' }));
  renderUploadList();
  if (!UploadQueue.running) runUploadQueue();
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
    : `"${items[0]?.file.name || ''}" 처리하는 중...`;
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
      const fd = new FormData();
      fd.append('file', it.file);
      const conti = await apiJson('/api/scores', { method: 'POST', body: fd });
      it.conti = conti;
      if (conti.duplicate) {
        it.status = 'dup';
      } else {
        it.status = 'ok';
        it.note = `곡 ${conti.songs.length}개`;
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
  if (ok.length) showToast(`콘티 ${ok.length}개 업로드 완료 — 곡 ${songCount}개를 찾았어요.`, 'success', 5000);
  if (dupes.length) showToast(`이미 올린 콘티라서 다시 저장하지 않았어요: ${dupes.map(x => x.file.name).join(', ')}`, 'info', 6000);
  items.filter(x => x.status === 'fail').forEach(x => showToast(`업로드 실패: ${x.file.name}: ${x.note}`, 'error', 7000));

  resetFilters();
  LibState.tab = items.length > 1 ? 'contis' : 'songs';
  await refreshAll();
  // 파일 하나를 올렸으면 그 콘티의 곡들을 바로 보여준다 (여러 개면 콘티 목록 탭)
  const last = items.length === 1 ? items[0].conti : null;
  if (last) openContiModal(last.id);
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
