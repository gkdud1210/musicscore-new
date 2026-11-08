/**
 * 라이브 모드 (NOW)
 * - 한 사람이 콘티(또는 새 콘티 트레이)에서 📡 NOW를 누르면 서버에 "지금 이 콘티" 를 올린다.
 * - 접속한 사람들은 몇 초마다 확인하다가 새 라이브가 생기면 깜빡이는 알림을 받고,
 *   OKAY를 누르면 콘티 악보를 순서대로 옆으로 넘겨 보는 화면이 열린다.
 * 사용자 데이터는 escapeHtml을 거쳐서만 innerHTML에 넣는다.
 */

const LIVE_POLL_MS = 4000;
const LIVE_SEEN_KEY = 'scoreshift.live.seen';

const LiveState = { live: null, timer: null, viewerOpen: false, titleTimer: null, originalTitle: document.title };

function liveSeenId() {
  try { return Number(localStorage.getItem(LIVE_SEEN_KEY) || 0); } catch { return 0; }
}
function setLiveSeen(id) {
  try { localStorage.setItem(LIVE_SEEN_KEY, String(id)); } catch { /* 저장 불가 환경 */ }
}

/* ── 서버 확인 (몇 초마다) ─────────────────────────────── */
async function pollLive() {
  if (document.hidden) return;
  try {
    const { live } = await apiJson('/api/live');
    applyLive(live);
  } catch { /* 잠깐 끊겨도 다음 확인 때 다시 */ }
}

function applyLive(live) {
  const prev = LiveState.live;
  LiveState.live = live;
  renderLiveIndicator();
  if (!live) {
    hideLiveAlert();
    if (prev && LiveState.viewerOpen && !LiveState.viewing?.local) {
      showToast('라이브가 끝났어요.', 'info');
      closeLiveViewer();
    }
    return;
  }
  if (live.id !== liveSeenId()) showLiveAlert(live);
  // 보고 있는 중에 다른 콘티로 바뀌면 알림으로 알려준다 (showLiveAlert가 처리)
}

function startLivePolling() {
  pollLive();
  clearInterval(LiveState.timer);
  LiveState.timer = setInterval(pollLive, LIVE_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });
}

/* ── NOW 보내기 / 끝내기 ───────────────────────────────── */
async function sendLive(title, songIds) {
  if (!songIds.length) { showToast('보낼 곡이 없어요.', 'info'); return; }
  if (!confirm(`"${title}" 콘티를 지금 접속한 모든 사람에게 띄울까요?`)) return;
  try {
    const { live } = await apiJson('/api/live', jsonBody('POST', { title, song_ids: songIds }));
    setLiveSeen(live.id);          // 보낸 사람은 알림 없이 바로 화면을 연다
    LiveState.live = live;
    renderLiveIndicator();
    if (typeof closeModal === 'function' && LibState?.modal) closeModal();
    openLiveViewer();
    showToast('📡 NOW! 접속한 사람들에게 알림을 보냈어요.', 'success');
  } catch (e) {
    showToast('NOW 보내기 실패: ' + e.message, 'error');
  }
}

async function stopLive() {
  if (!confirm('라이브를 끝낼까요? 다른 사람들 화면의 라이브 표시도 사라져요.')) return;
  try {
    await apiJson('/api/live', { method: 'DELETE' });
    LiveState.live = null;
    renderLiveIndicator();
    closeLiveViewer();
  } catch (e) {
    showToast('실패: ' + e.message, 'error');
  }
}

/** 콘티 화면의 NOW 버튼: 콘티 곡 순서대로 보낸다 */
function sendLiveFromConti() {
  const m = LibState.modal;
  if (!m || m.type !== 'conti' || !m.songs) return;
  const songs = [...m.songs].sort((a, b) => a.page_start - b.page_start);
  const conti = LibState.contis.find(c => c.id === m.id);
  sendLive(conti?.title || songs[0]?.conti_title || '오늘 콘티', songs.map(s => s.id));
}

/** 새 콘티 트레이의 NOW 버튼: 담은 순서대로 보낸다 */
function sendLiveFromSetlist() {
  const title = document.getElementById('setlistTitle')?.value.trim() || nextSundayLabel();
  sendLive(title, LibState.setlist.map(s => s.id));
}

/* ── 깜빡이는 알림 ─────────────────────────────────────── */
function showLiveAlert(live) {
  let el = document.getElementById('liveAlert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'liveAlert';
    el.className = 'live-alert';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <span class="live-dot"></span>
    <div class="live-alert-text">
      <strong>NOW · ${escapeHtml(live.title)}</strong>
      <span>${liveSetsOf(live).length > 1 ? `콘티 ${liveSetsOf(live).length}개 · ` : ''}${live.songs.length}곡 · ${escapeHtml(live.started_at || '')} 시작 · 지금 이 콘티로 찬양해요</span>
    </div>
    <button type="button" class="live-ok-btn" data-live="ok">OKAY</button>
    <button type="button" class="live-alert-x" data-live="dismiss" aria-label="나중에">×</button>`;
  el.classList.remove('hidden');
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* 진동 없음 */ }
  clearInterval(LiveState.titleTimer);
  let on = false;
  LiveState.titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? '🔴 NOW · ' + live.title : LiveState.originalTitle;
  }, 1000);
}

function hideLiveAlert() {
  document.getElementById('liveAlert')?.classList.add('hidden');
  clearInterval(LiveState.titleTimer);
  document.title = LiveState.originalTitle;
}

/* ── 헤더의 라이브 표시 (닫은 뒤 다시 열기용) ─────────── */
function renderLiveIndicator() {
  let el = document.getElementById('liveIndicator');
  const live = LiveState.live;
  if (!live) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('button');
    el.id = 'liveIndicator';
    el.type = 'button';
    el.className = 'live-indicator';
    el.dataset.live = 'open';
    document.body.appendChild(el);
  }
  el.innerHTML = `<span class="live-dot"></span> LIVE · ${escapeHtml(live.title)}`;
  el.classList.toggle('hidden', LiveState.viewerOpen);
}

/* ── 라이브 화면: 위 메뉴에서 콘티를 오가며, 악보를 옆으로 넘겨 보기 ─────────────── */
/** 서버 라이브 → 콘티 묶음. 예전 형식(songs만)은 콘티 하나로 */
function liveSetsOf(live) {
  if (live?.sets?.length) return live.sets;
  return live ? [{ title: live.title, songs: live.songs || [] }] : [];
}

function liveSlides(set) {
  const slides = [];
  (set?.songs || []).forEach((s, si) => s.image_urls.forEach((url, pi) =>
    slides.push({ si, pi, pages: s.image_urls.length, song: s, url })));
  return slides;
}

/** 라이브 화면 열기. local 이 있으면 서버 라이브 대신 그 콘티들을 나만 본다 */
function openLiveViewer(local = null) {
  const live = local || LiveState.live;
  if (!live) return;
  if (!local) { setLiveSeen(live.id); hideLiveAlert(); }
  // 같은 라이브를 다시 열면 보던 콘티·쪽을 그대로
  const same = LiveState.viewing && LiveState.viewing.id === live.id;
  LiveState.viewing = {
    id: live.id, title: live.title, local: !!local,
    sets: [...liveSetsOf(live), ...(same ? LiveState.viewing.sets.filter(st => st.mine) : [])],
    cur: same ? LiveState.viewing.cur : 0,
    pos: same ? LiveState.viewing.pos : {},
  };
  let v = document.getElementById('liveViewer');
  if (!v) {
    v = document.createElement('div');
    v.id = 'liveViewer';
    v.className = 'live-viewer';
    document.body.appendChild(v);
  }
  v.classList.remove('hidden');
  document.body.classList.add('modal-open');
  LiveState.viewerOpen = true;
  renderLiveIndicator();
  keepScreenOn(true);
  renderLiveSet();
}

function renderLiveSet() {
  const V = LiveState.viewing;
  const v = document.getElementById('liveViewer');
  if (!V || !v) return;
  V.cur = Math.max(0, Math.min(V.sets.length - 1, V.cur));
  const set = V.sets[V.cur];
  const slides = liveSlides(set);
  LiveState.slides = slides;
  v.innerHTML = `
    <div class="live-top">
      <span class="live-badge"><span class="live-dot"></span> ${V.local ? '보기' : 'LIVE'}</span>
      <div class="live-now" id="liveNow"></div>
      <button type="button" class="live-top-btn" data-live="fullscreen" title="전체 화면">⛶</button>
      ${V.local ? '' : '<button type="button" class="live-top-btn" data-live="stop" title="라이브 끝내기 (모두)">■ 끝내기</button>'}
      <button type="button" class="live-top-btn" data-live="close" aria-label="닫기">✕</button>
    </div>
    <div class="live-sets" id="liveSets" role="tablist" aria-label="콘티">
      ${V.sets.map((st, i) => `<button type="button" role="tab" aria-selected="${i === V.cur}" class="live-set-tab${i === V.cur ? ' active' : ''}${st.mine ? ' mine' : ''}"
          data-live="set" data-set="${i}">${i + 1}. ${escapeHtml(st.title)} <span>${st.songs.length}곡</span></button>`).join('')}
      <button type="button" class="live-set-tab add" data-live="add-set" title="다른 콘티도 위에 추가해서 보기 (내 화면에만)">＋ 콘티</button>
    </div>
    <div class="live-add hidden" id="liveAdd"></div>
    <div class="live-songs" id="liveSongs">
      ${set.songs.map((s, i) => `<button type="button" class="live-song-chip" data-live="jump" data-song="${i}">
        ${i + 1}. ${escapeHtml(s.title)}${s.key ? ` <b>${escapeHtml(s.key)}</b>` : ''}</button>`).join('')}
    </div>
    <div class="live-track" id="liveTrack">
      ${slides.map((sl, i) => `<div class="live-slide" data-index="${i}">
        <img src="${API_BASE}${sl.url}" alt="${escapeHtml(sl.song.title)}" ${i < 3 ? '' : 'loading="lazy"'} draggable="false" />
      </div>`).join('')}
    </div>
    <button type="button" class="live-nav prev" data-live="prev" aria-label="이전">‹</button>
    <button type="button" class="live-nav next" data-live="next" aria-label="다음">›</button>`;

  const track = document.getElementById('liveTrack');
  const start = Math.min(V.pos[V.cur] || 0, Math.max(0, slides.length - 1));
  track.scrollLeft = start * track.clientWidth;
  let raf = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(updateLiveNow);
  }, { passive: true });
  updateLiveNow();
  document.querySelector('.live-set-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function switchLiveSet(i, at = 'keep') {
  const V = LiveState.viewing;
  if (!V || i < 0 || i >= V.sets.length) return;
  V.pos[V.cur] = liveIndex();
  V.cur = i;
  if (at === 'first') V.pos[i] = 0;
  if (at === 'last') V.pos[i] = Math.max(0, liveSlides(V.sets[i]).length - 1);
  renderLiveSet();
}

function liveIndex() {
  const track = document.getElementById('liveTrack');
  return track ? Math.round(track.scrollLeft / Math.max(1, track.clientWidth)) : 0;
}

/** 다음/이전: 콘티 끝에서 넘기면 다음 콘티로 이어진다 */
function stepLive(delta) {
  const V = LiveState.viewing;
  const n = (LiveState.slides || []).length;
  const i = liveIndex() + delta;
  if (V && i >= n && V.cur < V.sets.length - 1) {
    switchLiveSet(V.cur + 1, 'first');
    showToast(`▶ ${V.sets[V.cur].title}`, 'info', 1500);
    return;
  }
  if (V && i < 0 && V.cur > 0) {
    switchLiveSet(V.cur - 1, 'last');
    return;
  }
  goLiveSlide(i);
}

function goLiveSlide(i) {
  const track = document.getElementById('liveTrack');
  if (!track || !LiveState.slides) return;
  const n = Math.max(0, Math.min(LiveState.slides.length - 1, i));
  track.scrollTo({ left: n * track.clientWidth, behavior: 'smooth' });
}

function updateLiveNow() {
  const slides = LiveState.slides || [];
  const V = LiveState.viewing;
  const i = liveIndex();
  const sl = slides[i];
  if (V) V.pos[V.cur] = i;
  if (!sl) return;
  document.getElementById('liveNow').innerHTML = `
    <strong>${sl.si + 1}. ${escapeHtml(sl.song.title)}</strong>
    ${sl.song.key ? `<span class="live-key">${escapeHtml(sl.song.key)}</span>` : ''}
    <span class="live-count">${sl.pages > 1 ? `${sl.pi + 1}/${sl.pages}쪽 · ` : ''}${i + 1} / ${slides.length}</span>`;
  document.querySelectorAll('.live-song-chip').forEach((b, k) => b.classList.toggle('active', k === sl.si));
  document.querySelector('.live-song-chip.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function closeLiveViewer() {
  const v = document.getElementById('liveViewer');
  if (v) { v.classList.add('hidden'); v.innerHTML = ''; }
  LiveState.viewerOpen = false;
  keepScreenOn(false);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (!document.querySelector('.lib-modal:not(.hidden)')) document.body.classList.remove('modal-open');
  renderLiveIndicator();
}

/* ── 연주하는 동안 화면이 꺼지지 않게 ─────────────────── */
async function keepScreenOn(on) {
  try {
    if (on && 'wakeLock' in navigator && !LiveState.wakeLock) {
      LiveState.wakeLock = await navigator.wakeLock.request('screen');
      LiveState.wakeLock.addEventListener?.('release', () => { LiveState.wakeLock = null; });
    } else if (!on && LiveState.wakeLock) {
      await LiveState.wakeLock.release();
      LiveState.wakeLock = null;
    }
  } catch { /* 지원 안 하는 기기 */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && LiveState.viewerOpen) keepScreenOn(true); });

function toggleLiveFullscreen() {
  const v = document.getElementById('liveViewer');
  if (!v) return;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else (v.requestFullscreen || v.webkitRequestFullscreen)?.call(v);
}

/* ── 라이브 화면에서 다른 콘티를 위 메뉴에 더하기 (내 화면에만) ───── */
async function openLiveAdd() {
  const box = document.getElementById('liveAdd');
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="live-add-empty">불러오는 중...</p>';
  let contis = (typeof LibState !== 'undefined' && LibState.contis?.length) ? LibState.contis : null;
  if (!contis) { try { contis = await apiJson('/api/scores'); } catch { contis = []; } }
  const setlist = (typeof LibState !== 'undefined' && LibState.setlist) || [];
  box.innerHTML = `
    <input type="search" class="live-add-search" id="liveAddSearch" placeholder="콘티 이름·날짜로 찾기" />
    <div class="live-add-list" id="liveAddList">
      ${setlist.length ? `<button type="button" class="live-add-item" data-live="add-setlist">🎼 담은 곡 (${setlist.length}곡)</button>` : ''}
      ${contis.filter(c => c.songs?.length).map(c => `<button type="button" class="live-add-item" data-live="add-conti" data-id="${c.id}"
          data-q="${escapeHtml(`${c.title} ${c.conti_date || ''}`.toLowerCase().normalize('NFC'))}">
          ${c.conti_date ? `<span>${escapeHtml(c.conti_date)}</span> ` : ''}${escapeHtml(c.title)} <small>${c.songs.length}곡</small></button>`).join('')}
    </div>`;
  document.getElementById('liveAddSearch').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase().normalize('NFC');
    document.querySelectorAll('#liveAddList .live-add-item[data-q]').forEach(b => { b.hidden = q && !b.dataset.q.includes(q); });
  });
}

async function addLiveSet(set) {
  const V = LiveState.viewing;
  if (!V || !set?.songs?.length) return;
  V.sets.push({ ...set, mine: true });
  switchLiveSet(V.sets.length - 1, 'first');
}

/** 콘티 하나 → 라이브용 곡 목록 (페이지 순서, 이미지 주소 포함) */
async function liveSetFromConti(contiId, title) {
  const songs = (await apiJson(`/api/songs?score_id=${contiId}`)).sort((a, b) => a.page_start - b.page_start);
  return { title, conti_id: contiId, songs: songs.map(s => ({ id: s.id, title: s.title, key: s.key, image_urls: s.image_urls })) };
}

async function liveSetFromSongIds(ids, title) {
  const songs = await Promise.all(ids.map(id => apiJson(`/api/songs/${id}`).catch(() => null)));
  return { title, songs: songs.filter(Boolean).map(s => ({ id: s.id, title: s.title, key: s.key, image_urls: s.image_urls })) };
}

/* ── 이벤트 ─────────────────────────────────────────────── */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-live]');
  if (!el) return;
  switch (el.dataset.live) {
    case 'ok':
    case 'open': openLiveViewer(); break;
    case 'dismiss':
      if (LiveState.live) setLiveSeen(LiveState.live.id);
      hideLiveAlert();
      break;
    case 'close': closeLiveViewer(); break;
    case 'stop': stopLive(); break;
    case 'prev': stepLive(-1); break;
    case 'next': stepLive(1); break;
    case 'set': switchLiveSet(Number(el.dataset.set)); break;
    case 'fullscreen': toggleLiveFullscreen(); break;
    case 'add-set': openLiveAdd(); break;
    case 'add-conti': {
      const c = (typeof LibState !== 'undefined' && LibState.contis || []).find(x => x.id === Number(el.dataset.id));
      liveSetFromConti(Number(el.dataset.id), c?.title || el.textContent.trim())
        .then(addLiveSet).catch(err => showToast('불러오기 실패: ' + err.message, 'error'));
      break;
    }
    case 'add-setlist':
      liveSetFromSongIds(LibState.setlist.map(s => s.id), '담은 곡')
        .then(addLiveSet).catch(err => showToast('불러오기 실패: ' + err.message, 'error'));
      break;
    case 'jump': {
      const si = Number(el.dataset.song);
      goLiveSlide((LiveState.slides || []).findIndex(s => s.si === si));
      break;
    }
    case 'send-conti': sendLiveFromConti(); break;
    case 'send-setlist': sendLiveFromSetlist(); break;
  }
});

document.addEventListener('keydown', e => {
  if (!LiveState.viewerOpen) return;
  if (e.target.closest?.('input, textarea')) return;
  // 페이지 넘김 페달(블루투스)은 보통 → / PageDown 을 보낸다
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); stepLive(1); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stepLive(-1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); switchLiveSet((LiveState.viewing?.cur ?? 0) + 1, 'first'); }
  if (e.key === 'ArrowUp') { e.preventDefault(); switchLiveSet((LiveState.viewing?.cur ?? 0) - 1, 'first'); }
  if (/^[1-9]$/.test(e.key)) switchLiveSet(Number(e.key) - 1);
  if (e.key === 'Escape') closeLiveViewer();
});

window.addEventListener('resize', () => {
  if (LiveState.viewerOpen) {
    const t = document.getElementById('liveTrack');
    const V = LiveState.viewing;
    if (t && V) t.scrollLeft = (V.pos[V.cur] || 0) * t.clientWidth;
  }
});

window.addEventListener('DOMContentLoaded', () => {
  (typeof AuthState !== 'undefined' ? AuthState.ready : Promise.resolve()).finally(startLivePolling);
});
