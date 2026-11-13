/**
 * 라이브 모드 (함께 보는 콘티)
 * - 누가 📡 라이브를 시작하면 서버에 올라가고, 접속한 사람들은 몇 초마다 확인하다 깜빡이는 알림을 받는다.
 * - 라이브가 켜져 있는 동안 팀원 누구나 ＋ 콘티로 콘티를 더할 수 있고, 모두의 위 메뉴에 같이 생긴다.
 * - 📣 알림주기: 지금 보고 있는 콘티(곡)로 모두의 화면이 넘어간다.
 * - 🚪 나가기는 내 화면만. 라이브를 켠 사람은 나가기에서 "나만 나가기 / 라이브 끝내기"를 고른다.
 * - 📨 다시 초대: 나갔던 사람까지 다시 알림, OKAY 하면 들어온다.
 * 사용자 데이터는 escapeHtml을 거쳐서만 innerHTML에 넣는다.
 */

const LIVE_POLL_MS = 4000;
const LIVE_POLL_VIEWING_MS = 2500;   // 라이브 화면을 보는 중엔 더 자주 (알림주기가 빨리 오게)
const LIVE_SEEN_KEY = 'scoreshift.live.seen';
const LIVE_LEFT_KEY = 'jandi.live.left';
const LIVE_FOCUS_KEY = 'jandi.live.focus';
const LIVE_MSG_KEY = 'jandi.live.msg';

const LiveState = { live: null, timer: null, viewerOpen: false, titleTimer: null, originalTitle: document.title };

function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* 저장 불가 환경 */ } }
const liveLeft = live => !!live && lsGet(LIVE_LEFT_KEY) === String(live.id);
/** 이 라이브에서 마지막으로 본 알림주기 시각 */
function focusSeenTs(live) {
  const [id, ts] = lsGet(LIVE_FOCUS_KEY).split(':');
  return live && id === String(live.id) ? Number(ts) || 0 : 0;
}
function setFocusSeen(live) {
  if (live?.focus) lsSet(LIVE_FOCUS_KEY, `${live.id}:${live.focus.ts}`);
}
const LIVE_INVITE_KEY = 'jandi.live.invite';
function inviteSeenTs(live) {
  const [id, ts] = lsGet(LIVE_INVITE_KEY).split(':');
  return live && id === String(live.id) ? Number(ts) || 0 : 0;
}
function setInviteSeen(live) {
  if (live?.invite) lsSet(LIVE_INVITE_KEY, `${live.id}:${live.invite.ts}`);
}
const normQ = t => String(t || '').toLowerCase().normalize('NFC').replace(/\s+/g, '');

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
  const V = LiveState.viewing;
  const watching = LiveState.viewerOpen && V && !V.local && V.id === live.id;
  // 다른 관리자가 콘티를 더했거나 알림주기를 했으면 화면을 맞춘다
  if (watching && V.rev !== live.rev) syncLiveViewer(live);

  const newFocus = live.focus && live.focus.ts > focusSeenTs(live);
  const newInvite = live.invite && live.invite.ts > inviteSeenTs(live);
  if (newInvite) {
    if (watching || LiveState.sentInviteTs === live.invite.ts) setInviteSeen(live);
    else { showLiveAlert(live, 'invite'); return; }   // 나갔던 사람도 다시 초대받는다
  }
  if (liveLeft(live)) {             // 나간 사람에게는 알리지 않는다
    if (newFocus) setFocusSeen(live);
    return;
  }
  if (watching) {
    maybeShowLiveMessage(live);
    if (newFocus) {
      setFocusSeen(live);
      if (jumpToFocus(live)) showToast(`📣 지금: ${live.focus.title}`, 'info', 3000);
    }
    return;
  }
  if (live.id !== liveSeenId()) showLiveAlert(live);
  else if (newFocus) showLiveAlert(live, true);
}

function scheduleLivePoll() {
  clearTimeout(LiveState.timer);
  LiveState.timer = setTimeout(async () => {
    await pollLive();
    scheduleLivePoll();
  }, LiveState.viewerOpen ? LIVE_POLL_VIEWING_MS : LIVE_POLL_MS);
}

function startLivePolling() {
  pollLive();
  scheduleLivePoll();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });
}

/* ── NOW 보내기 / 끝내기 ───────────────────────────────── */
async function sendLive(title, songIds, contiId = null) {
  if (!songIds.length) { showToast('보낼 곡이 없어요.', 'info'); return; }
  const running = LiveState.live;
  if (!confirm(running
    ? `지금 진행 중인 라이브 "${running.title}"에 "${title}" 콘티를 더할까요?`
    : `"${title}" 콘티로 라이브를 시작할까요? 지금 접속한 모든 사람에게 알림이 가요.`)) return;
  try {
    const { live, joined } = await apiJson('/api/live', jsonBody('POST', { title, song_ids: songIds, conti_id: contiId }));
    setLiveSeen(live.id);          // 보낸 사람은 알림 없이 바로 화면을 연다
    lsSet(LIVE_LEFT_KEY, '');
    setFocusSeen(live);
    LiveState.live = live;
    renderLiveIndicator();
    if (typeof closeModal === 'function' && LibState?.modal) closeModal();
    openLiveViewer();
    if (joined) {
      const set = [...live.sets].reverse().find(st => st.title === title);
      if (set) switchLiveSetKey(set.key, 'first');
    }
    showToast(joined ? '진행 중인 라이브에 콘티를 더했어요. 모두의 화면에 같이 보여요.' : '📡 라이브 시작! 접속한 사람들에게 알림을 보냈어요.', 'success');
  } catch (e) {
    showToast('라이브 실패: ' + e.message, 'error');
  }
}

/** 라이브를 켠 사람이 나가기를 누르면: 나만 나가기 / 모두 끝내기 고르기 (잘못 눌러도 바로 끝나지 않게) */
/* ── 📋 사진 붙여넣기: 복사한 사진을 붙여넣으면 바로 모두의 라이브 화면에 ─────────── */
const clipImage = dt => [...(dt?.items || [])].find(it => it.kind === 'file' && /^image\//.test(it.type))?.getAsFile() || null;

async function pasteLivePhoto(file) {
  if (!file || LiveState.pasting) return;
  if (typeof decodeImage !== 'function') { showToast('이 화면에서는 사진을 붙여넣을 수 없어요.', 'info'); return; }
  const running = LiveState.live;
  if (!running && !confirm('진행 중인 라이브가 없어요.\n이 사진으로 라이브를 시작할까요? 지금 접속한 모든 사람에게 알림이 가요.')) return;
  LiveState.pasting = true;
  showToast('📋 사진 올리는 중...', 'info', 2000);
  try {
    const src = await decodeImage(file);
    const fd = new FormData();
    fd.append('image', await imageToJpeg(src, PAGE_IMAGE_WIDTH), 'paste.jpg');
    src.close?.();
    const { live, started } = await apiJson('/api/live/photo', { method: 'POST', body: fd });
    setLiveSeen(live.id);
    lsSet(LIVE_LEFT_KEY, '');
    setFocusSeen(live);
    if (live.invite) { LiveState.sentInviteTs = live.invite.ts; setInviteSeen(live); }
    LiveState.live = live;
    renderLiveIndicator();
    const V = LiveState.viewing;
    if (LiveState.viewerOpen && V && !V.local && V.id === live.id) syncLiveViewerQuiet(live);
    else {
      if (typeof closeModal === 'function' && typeof LibState !== 'undefined' && LibState.modal) closeModal(true);
      if (LiveState.viewerOpen) closeLiveViewer();
      openLiveViewer();
    }
    jumpToFocus(live);
    showToast(started ? '📡 붙여넣은 사진으로 라이브를 시작했어요.' : '📋 붙여넣은 사진을 모두의 화면에 띄웠어요.', 'success');
  } catch (e) {
    showToast('사진 띄우기 실패: ' + e.message, 'error');
  } finally {
    LiveState.pasting = false;
  }
}

/** 📋 버튼 (휴대폰): 복사해 둔 사진을 읽고, 안 되면 사진 고르기 */
async function pickLivePhoto() {
  try {
    if (navigator.clipboard?.read) {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => /^image\//.test(t));
        if (type) { pasteLivePhoto(new File([await item.getType(type)], 'paste', { type })); return; }
      }
    }
  } catch { /* 복사한 사진을 못 읽으면 고르기로 */ }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => { if (input.files[0]) pasteLivePhoto(input.files[0]); };
  input.click();
}

/* ── 붙여넣은 사진 정리: 🗑 지우기(모두의 화면에서) · 💾 콘티로 담기(콘티 목록에 새 콘티로) ─────── */
const LIVE_PASTE_KEY = 'paste';


/** 🎼 새 콘티에 담기 칩: 보고 있는 콘티의 곡들을 아래 "🎼 담은 곡"(새 콘티)에. 붙여넣은 사진은 관리자만 (먼저 콘티로 저장해야 해서) */
function toSetlistChipHtml(set) {
  if (!set?.songs.length || typeof toSetlistItem !== 'function') return '';
  const photos = set.songs.some(s => !s.id);
  if (photos && !AuthState.canEdit) return '';
  return `<button type="button" class="live-song-chip paste-tool" data-live="to-setlist" title="${photos
    ? '붙여넣은 사진들을 콘티 목록에 저장하고(AI가 곡으로 나눠요) 새 콘티에 담아요'
    : '이 콘티의 곡들을 새 콘티에 담아요 (라이브를 닫으면 아래 🎼 담은 곡에서 저장·PDF 내보내기)'}">🎼 새 콘티에 담기${photos ? ` (${set.songs.length}장)` : ''}</button>`;
}

/** 보고 있는 콘티 → 🎼 담은 곡. 붙여넣은 사진은 먼저 콘티 목록에 저장한 뒤 그 곡들을 담는다 */
async function liveSetToSetlist() {
  const V = LiveState.viewing;
  const set = V?.sets[V.cur];
  if (!set) return;
  if (set.songs.some(s => !s.id)) {
    const conti = await saveLivePhotosAsConti();
    if (conti?.id) await addContiToSetlist(conti.id);
    return;
  }
  let added = 0;
  for (const s of set.songs) {
    if (inSetlist(s.id)) continue;
    LibState.setlist.push(toSetlistItem({ ...s, ...(findSongAnywhere(s.id) || {}) }));
    added++;
  }
  afterSetlistChange();
  showToast(added ? `🎼 ${added}곡을 새 콘티에 담았어요. 라이브를 닫으면 아래 🎼 담은 곡에서 순서를 바꾸고 저장·PDF로 내보낼 수 있어요.`
    : '이 콘티의 곡은 이미 다 담겨 있어요.', added ? 'success' : 'info', added ? 6000 : 3000);
}

/** 악보 이름 옆 ✕: 그 곡을 콘티에서 뺀다. 함께 보는 라이브면 모두의 화면에서(붙여넣은 사진은 사진도 지움), 내 화면에만 더한 콘티·혼자 보기면 내 화면에서만 */
function canRemoveLiveSong(set) {
  const V = LiveState.viewing;
  if (!V || (V.sets.length <= 1 && set.songs.length <= 1)) return false;   // 마지막 악보는 X (→ ■ 종료)
  return set.mine || V.local || !!LiveState.live?.can_edit;
}

async function removeLiveSong(si) {
  const V = LiveState.viewing;
  const set = V?.sets[V.cur];
  const song = set?.songs[si];
  if (!song || !canRemoveLiveSong(set) || LiveState.removingSong) return;
  // 보던 쪽 지키기: 뺀 곡보다 뒤를 보고 있었으면 그만큼 당기고, 뺀 곡을 보고 있었으면 다음 곡 처음으로
  const slides = liveSlides(set);
  const at = liveIndex();
  const curSi = slides[at]?.si ?? 0;
  const startOf = slides.findIndex(sl => sl.si === si);
  const pos = curSi > si ? at - song.image_urls.length : curSi === si ? startOf : at;
  if (set.mine || V.local) {
    set.songs = set.songs.filter((_, k) => k !== si);
    if (!set.songs.length) { removeLiveSet(V.cur); return; }
    V.pos[set.key] = pos;
    renderLiveSet();
    showToast(`✕ "${song.title}"을(를) 내 화면에서 뺐어요.`, 'success');
    return;
  }
  LiveState.removingSong = true;
  try {
    const { live } = await apiJson(`/api/live/sets/${encodeURIComponent(set.key)}/remove-song`,
      jsonBody('POST', { index: si, url: song.image_urls[0] || '' }));
    LiveState.live = live;
    syncLiveViewerQuiet(live);
    if (V.sets[V.cur]?.key === set.key) V.pos[set.key] = pos;
    renderLiveSet();
    showToast(`✕ "${song.title}"을(를) 뺐어요. 모두의 화면에서 빠져요.`, 'success');
  } catch (e) {
    showToast('악보 빼기 실패: ' + e.message, 'error');
  } finally {
    LiveState.removingSong = false;
  }
}

async function saveLivePhotosAsConti() {
  const set = LiveState.viewing?.sets.find(st => st.key === LIVE_PASTE_KEY);
  const urls = (set?.songs || []).flatMap(s => s.image_urls);
  if (!urls.length || LiveState.savingPhotos) return null;
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const title = prompt(`붙여넣은 사진 ${urls.length}장을 콘티 목록에 새 콘티로 담아요.\nAI가 읽어서 곡으로 나눠요. 콘티 이름:`,
    `붙여넣은 사진 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  if (title === null) return null;
  LiveState.savingPhotos = true;
  const progress = t => showToast(`💾 ${t}...`, 'info', 4000);
  try {
    progress('사진 가져오는 중');
    const files = await Promise.all(urls.map(async (u, i) => {
      const res = await fetch(`${API_BASE}${u}`);
      if (!res.ok) throw new Error(`${i + 1}번째 사진을 못 가져왔어요 (지난 사진은 하루 뒤에 지워져요)`);
      return new File([await res.blob()], `p${i + 1}.jpg`, { type: 'image/jpeg' });
    }));
    let conti = await clientUploadImages(files, title.trim() || '붙여넣은 사진', progress);
    if (conti.duplicate) { showToast(`이미 같은 사진으로 만든 콘티가 있어서 그 콘티를 써요: "${conti.title || conti.filename || ''}"`, 'info', 5000); return conti; }
    if (conti.status === 'processing') conti = await waitForAnalysis(conti, progress);
    if (conti.status === 'error') throw new Error(conti.status_detail || '분석 실패');
    showToast(`💾 콘티 목록에 담았어요 (곡 ${conti.songs?.length || 0}개). 콘티 화면에서 제목·키를 확인해주세요.`, 'success', 6000);
    if (typeof refreshAll === 'function') refreshAll().catch(() => {});
    return conti;
  } catch (e) {
    showToast('콘티로 담기 실패: ' + e.message, 'error');
    return null;
  } finally {
    LiveState.savingPhotos = false;
  }
}

document.addEventListener('paste', e => {
  const file = clipImage(e.clipboardData);
  if (!file) return;   // 글자 붙여넣기는 그대로
  e.preventDefault();
  pasteLivePhoto(file);
});

function openLeaveChoice() {
  document.getElementById('liveLeaveSheet')?.remove();
  const el = document.createElement('div');
  el.id = 'liveLeaveSheet';
  el.className = 'live-leave-sheet';
  el.innerHTML = `<div class="live-leave-box" role="dialog" aria-modal="true" aria-label="라이브 나가기">
    <p class="live-leave-title">내가 시작한 라이브예요</p>
    <button type="button" class="live-leave-btn" data-live="leave-only">🚪 나만 나가기 <small>라이브는 다른 사람들에게 계속돼요</small></button>
    <button type="button" class="live-leave-btn end" data-live="stop-now">■ 라이브 끝내기 <small>모든 사람의 라이브 화면이 닫혀요</small></button>
    <button type="button" class="live-leave-cancel" data-live="leave-cancel">취소</button>
  </div>`;
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  (document.fullscreenElement || document.getElementById('liveViewer') || document.body).appendChild(el);
}

async function stopLive() {
  document.getElementById('liveLeaveSheet')?.remove();
  if (!confirm('라이브를 종료하시겠습니까?\n모든 사람의 라이브 화면이 닫혀요.')) return;
  try {
    await apiJson('/api/live', { method: 'DELETE' });
    LiveState.live = null;
    renderLiveIndicator();
    closeLiveViewer();
    showToast('라이브를 끝냈어요. 🕘 기록에 남아 있어서 ▶ 이어서 라이브로 다시 시작할 수 있어요.', 'success', 5000);
    if (typeof renderWorshipSetup === 'function' && LibState?.modal?.type === 'worship') renderWorshipSetup();
  } catch (e) {
    showToast('실패: ' + e.message, 'error');
  }
}

/** 나가기: 내 화면만 닫고, 이 라이브의 알림도 그만 받는다 (위의 LIVE 표시로 다시 들어올 수 있음) */
function leaveLive() {
  if (LiveState.live) {
    lsSet(LIVE_LEFT_KEY, LiveState.live.id);
    setLiveSeen(LiveState.live.id);
    setFocusSeen(LiveState.live);
  }
  hideLiveAlert();
  closeLiveViewer();
  showToast('라이브에서 나왔어요. 라이브는 다른 사람들에게 계속돼요. 아래 LIVE 를 누르면 다시 들어가고, 📨 다시 초대로 모두를 다시 부를 수 있어요.', 'info', 5000);
}

/** 📣 알림주기: 지금 보고 있는 콘티·곡으로 모두의 화면을 넘긴다 */
async function notifyLive() {
  const V = LiveState.viewing;
  const set = V?.sets[V.cur];
  if (!set) return;
  if (set.mine) { showToast('내 화면에만 더한 콘티는 알릴 수 없어요.', 'info'); return; }
  const sl = (LiveState.slides || [])[liveIndex()];
  try {
    const { live } = await apiJson('/api/live/focus', jsonBody('POST', { key: set.key, song: sl ? sl.si : 0 }));
    setFocusSeen(live);
    applyLive(live);
    showToast(`📣 모두에게 "${set.title}"${sl ? ` · ${sl.song.title}` : ''}을(를) 띄웠어요.`, 'success');
  } catch (e) {
    showToast('알림주기 실패: ' + e.message, 'error');
  }
}

/** 콘티 화면의 NOW 버튼: 콘티 곡 순서대로 보낸다 */
function sendLiveFromConti() {
  const m = LibState.modal;
  if (!m || m.type !== 'conti' || !m.songs) return;
  const songs = [...m.songs].sort((a, b) => a.page_start - b.page_start);
  const conti = LibState.contis.find(c => c.id === m.id);
  sendLive(conti?.songs?.length ? contiDisplayName(conti) : conti?.title || songs[0]?.conti_title || '오늘 콘티', songs.map(s => s.id), m.id);
}

/** 새 콘티 트레이의 NOW 버튼: 담은 순서대로 보낸다 */
function sendLiveFromSetlist() {
  const title = document.getElementById('setlistTitle')?.value.trim() || nextSundayLabel();
  sendLive(title, LibState.setlist.map(s => s.id));
}

/* ── 깜빡이는 알림 ─────────────────────────────────────── */
function showLiveAlert(live, focus = false) {
  let el = document.getElementById('liveAlert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'liveAlert';
    el.className = 'live-alert';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }
  const sets = liveSetsOf(live);
  el.innerHTML = focus === 'invite' ? `
    <span class="live-dot"></span>
    <div class="live-alert-text">
      <strong>📨 ${live.invite.from ? `${escapeHtml(live.invite.from)}님이 ` : ''}라이브에 초대했어요</strong>
      <span>${escapeHtml(live.title)} · OKAY 를 누르면 바로 들어가요</span>
    </div>
    <button type="button" class="live-ok-btn" data-live="ok">OKAY</button>
    <button type="button" class="live-alert-x" data-live="dismiss" aria-label="나중에">×</button>` : focus ? `
    <span class="live-dot"></span>
    <div class="live-alert-text">
      <strong>📣 지금 이 콘티 · ${escapeHtml(live.focus.title)}</strong>
      <span>${escapeHtml(live.title)} 라이브 · 눌러서 바로 보기</span>
    </div>
    <button type="button" class="live-ok-btn" data-live="ok">OKAY</button>
    <button type="button" class="live-alert-x" data-live="dismiss" aria-label="나중에">×</button>` : `
    <span class="live-dot"></span>
    <div class="live-alert-text">
      <strong>NOW · ${escapeHtml(live.title)}</strong>
      <span>${sets.length > 1 ? `콘티 ${sets.length}개 · ` : ''}${live.songs.length}곡 · ${escapeHtml(live.started_at || '')} 시작 · 지금 이 콘티로 찬양해요</span>
    </div>
    <button type="button" class="live-ok-btn" data-live="ok">OKAY</button>
    <button type="button" class="live-alert-x" data-live="dismiss" aria-label="나중에">×</button>`;
  el.classList.remove('hidden');
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* 진동 없음 */ }
  clearInterval(LiveState.titleTimer);
  let on = false;
  const label = focus === 'invite' ? '📨 라이브 초대 · ' + live.title : focus ? '📣 ' + live.focus.title : '🔴 NOW · ' + live.title;
  LiveState.titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? label : LiveState.originalTitle;
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
    el = document.createElement('div');
    el.id = 'liveIndicator';
    el.className = 'live-indicator';
    document.body.appendChild(el);
  }
  const min = liveIndMinimized(live);
  el.classList.toggle('min', min);
  el.innerHTML = min
    ? `<button type="button" class="live-ind-expand" data-live="ind-expand" title="LIVE 표시 펼치기" aria-label="LIVE 표시 펼치기"><span class="live-dot"></span> LIVE</button>`
    : `<button type="button" class="live-ind-open" data-live="open"><span class="live-dot"></span> LIVE · ${escapeHtml(live.title)}</button>
    <button type="button" class="live-ind-invite" data-live="invite" title="모두에게 다시 초대 알림을 보내고 들어가요">📨 다시 초대</button>
    <button type="button" class="live-ind-end" data-live="stop" title="라이브 종료 (모두의 라이브 화면이 닫혀요)">■ 종료</button>
    <button type="button" class="live-ind-min" data-live="ind-min" title="작게 접기" aria-label="작게 접기">−</button>`;
  el.classList.toggle('hidden', LiveState.viewerOpen);
}

/* LIVE 표시 접기/펼치기 (기기마다 기억, 새 라이브가 시작되면 다시 펼쳐짐) */
function liveIndMinimized(live) {
  try { return localStorage.getItem('jandi.live.indMin') === String(live.id); } catch { return false; }
}
function setLiveIndMinimized(min) {
  try {
    if (min && LiveState.live) localStorage.setItem('jandi.live.indMin', String(LiveState.live.id));
    else localStorage.removeItem('jandi.live.indMin');
  } catch { /* 저장 불가 */ }
  renderLiveIndicator();
}

/** 📨 다시 초대: 나갔던 사람까지 모두에게 알림 → OKAY 하면 들어온다. 나는 바로 들어간다 */
async function inviteLive() {
  try {
    const { live } = await apiJson('/api/live/invite', { method: 'POST' });
    LiveState.sentInviteTs = live.invite.ts;
    setInviteSeen(live);
    LiveState.live = live;
    openLiveViewer();
    showToast('📨 모두에게 다시 초대를 보냈어요.', 'success');
  } catch (e) {
    showToast('초대 실패: ' + e.message, 'error');
  }
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
  if (!local) {
    setLiveSeen(live.id);
    setInviteSeen(live);
    lsSet(LIVE_LEFT_KEY, '');
    hideLiveAlert();
  }
  // 같은 라이브를 다시 열면 보던 콘티·쪽을 그대로
  const same = LiveState.viewing && LiveState.viewing.id === live.id;
  const sets = liveSetsOf(live).map((st, i) => ({ ...st, key: st.key || `l${i}` }));
  LiveState.viewing = {
    id: live.id, title: live.title, local: !!local, rev: live.rev,
    sets: [...sets, ...(same ? LiveState.viewing.sets.filter(st => st.mine) : [])],
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
  if (!local) maybeShowLiveMessage(live, 60000);   // 들어오기 1분 안에 온 메세지만
  // 알림주기가 있었으면 그 콘티·곡에서 시작
  if (!local && live.focus && !same) {
    setFocusSeen(live);
    if (jumpToFocus(live)) return;
  }
  renderLiveSet();
}

/** 서버 라이브가 바뀌면(콘티 추가·알림주기) 보던 콘티와 쪽을 지키며 다시 그린다 */
function syncLiveViewer(live) {
  const V = LiveState.viewing;
  const curKey = V.sets[V.cur]?.key;
  V.pos[curKey] = liveIndex();
  const known = new Set(V.sets.map(st => st.key));
  V.sets = [...live.sets, ...V.sets.filter(st => st.mine)];
  V.rev = live.rev;
  V.title = live.title;
  V.cur = Math.max(0, V.sets.findIndex(st => st.key === curKey));
  const added = live.sets.filter(st => !known.has(st.key));
  const addBoxOpen = !document.getElementById('liveAdd')?.classList.contains('hidden')
    || !document.getElementById('liveMsgPanel')?.classList.contains('hidden');
  if (!addBoxOpen) renderLiveSet(); else renderLiveTabs();
  added.forEach(st => showToast(`＋ 새 콘티: ${st.title}`, 'info', 3000));
}

/** 알림주기한 콘티·곡으로 넘어가기 */
function jumpToFocus(live) {
  const V = LiveState.viewing;
  const f = live.focus;
  const i = V ? V.sets.findIndex(st => st.key === f?.key) : -1;
  if (i < 0) return false;
  if (V.sets[V.cur]) V.pos[V.sets[V.cur].key] = liveIndex();
  V.cur = i;
  V.pos[f.key] = Math.max(0, liveSlides(V.sets[i]).findIndex(sl => sl.si === f.song));
  renderLiveSet();
  return true;
}

function renderLiveTabs() {
  const V = LiveState.viewing;
  const box = document.getElementById('liveSets');
  if (!V || !box) return;
  const live = LiveState.live;
  const shared = !V.local && live?.can_edit;
  // ✕ 빼기: 콘티마다. 내 화면에만 더한 것·혼자 보기는 누구나, 함께 보는 라이브는 고칠 수 있는 사람만 (마지막 하나는 X)
  const canRemove = st => V.sets.length > 1 && (st.mine || V.local || shared);
  box.innerHTML = `
      ${V.sets.map((st, i) => `<span class="live-set-wrap${canRemove(st) ? ' has-x' : ''}"><button type="button" role="tab" aria-selected="${i === V.cur}" class="live-set-tab${i === V.cur ? ' active' : ''}${st.mine ? ' mine' : ''}${!V.local && live?.focus?.key === st.key ? ' focus' : ''}"
          data-live="set" data-set="${i}" title="${escapeHtml(st.title)} (${st.songs.length}곡)"><span class="live-set-name">${i + 1}. ${escapeHtml(st.title)}</span><span class="live-set-n">${st.songs.length}곡</span></button>${canRemove(st)
          ? `<button type="button" class="live-set-x" data-live="remove-set" data-set="${i}" title="${st.mine || V.local ? '이 콘티 빼기 (내 화면에서만)' : '이 콘티 빼기 (모두의 화면에서 빠져요)'}" aria-label="${escapeHtml(st.title)} 빼기">✕</button>` : ''}</span>`).join('')}
      <button type="button" class="live-set-tab add" data-live="add-set" title="${shared ? '콘티를 더하면 모두의 화면에 같이 생겨요' : '다른 콘티도 위에 추가해서 보기 (내 화면에만)'}">＋ 콘티</button>`;
  box.querySelector('.live-set-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function renderLiveSet() {
  const V = LiveState.viewing;
  const v = document.getElementById('liveViewer');
  if (!V || !v) return;
  V.cur = Math.max(0, Math.min(V.sets.length - 1, V.cur));
  const set = V.sets[V.cur];
  const slides = liveSlides(set);
  LiveState.slides = slides;
  const live = LiveState.live;
  const server = !V.local && live && live.id === V.id;
  const songX = canRemoveLiveSong(set);   // 악보 이름 옆 ✕ 로 빼기
  v.classList.toggle('top-min', liveTopMin());
  v.innerHTML = `
    <div class="live-top">
      <span class="live-badge"><span class="live-dot"></span> ${V.local ? '보기' : 'LIVE'}</span>
      <div class="live-now" id="liveNow"></div>
      ${server ? '<button type="button" class="live-top-btn notify" data-live="notify" title="지금 보고 있는 콘티·곡으로 모두의 화면을 넘겨요">📣 알림주기</button>' : ''}
      ${server ? '<button type="button" class="live-top-btn" data-live="paste" title="복사한 사진을 모두의 화면에 띄워요 (Ctrl/⌘+V 로 붙여넣어도 돼요)">📋 사진</button>' : ''}
      ${server ? '<button type="button" class="live-top-btn msg" data-live="msg" title="라이브 보는 모두의 악보 위에 메세지 띄우기">💬 메세지</button>' : ''}
      <button type="button" class="live-top-btn" data-live="scroll-mode" title="${liveVertical() ? '옆으로 넘기기로 바꾸기' : '밑으로 스크롤로 바꾸기'}">${liveVertical() ? '↕ 스크롤' : '↔ 넘기기'}</button>
      <button type="button" class="live-top-btn" data-live="fullscreen" title="전체 화면">⛶</button>
      ${!server ? '<button type="button" class="live-top-btn" data-live="close" aria-label="닫기">✕</button>'
        : `<button type="button" class="live-top-btn" data-live="leave" title="내 화면만 닫아요. 라이브는 다른 사람들에게 계속돼요">🚪 나가기</button>
          <button type="button" class="live-top-btn end" data-live="stop" title="라이브 종료 (모두의 라이브 화면이 닫혀요)">■ 종료</button>`}
      <button type="button" class="live-top-btn top-fold" data-live="top-fold" title="${liveTopMin() ? '버튼 줄 펼치기' : '버튼 줄 접기'}" aria-label="${liveTopMin() ? '버튼 줄 펼치기' : '버튼 줄 접기'}">${liveTopMin() ? '▾' : '▴'}</button>
    </div>
    <div class="live-sets" id="liveSets" role="tablist" aria-label="콘티"></div>
    <div class="live-add hidden" id="liveAdd"></div>
    <div class="live-add live-msg-panel hidden" id="liveMsgPanel"></div>
    <div class="live-songs" id="liveSongs">
      ${toSetlistChipHtml(set)}
      ${set.songs.map((s, i) => {
        const chip = `<button type="button" class="live-song-chip" data-live="jump" data-song="${i}">
        ${i + 1}. ${escapeHtml(s.title)}${s.key ? ` <b>${escapeHtml(s.key)}</b>` : ''}</button>`;
        return songX ? `<span class="live-chip-wrap">${chip}<button type="button" class="live-chip-x" data-live="song-x" data-song="${i}"
          title="${set.mine || V.local ? '이 악보 빼기 (내 화면에서만)' : '이 악보 빼기 (모두의 화면에서 빠져요)'}" aria-label="${escapeHtml(s.title)} 빼기">✕</button></span>` : chip;
      }).join('')}
    </div>
    <div class="live-track${liveVertical() ? ' vertical' : ''}" id="liveTrack">
      ${slides.map((sl, i) => `<div class="live-slide" data-index="${i}">
        <img src="${API_BASE}${sl.url}" alt="${escapeHtml(sl.song.title)}" ${i < 3 ? '' : 'loading="lazy"'} draggable="false" />
      </div>`).join('')}
    </div>
    <button type="button" class="live-nav prev" data-live="prev" aria-label="이전">‹</button>
    <button type="button" class="live-nav next" data-live="next" aria-label="다음">›</button>`;
  renderLiveTabs();

  const track = document.getElementById('liveTrack');
  const start = Math.min(V.pos[set.key] || 0, Math.max(0, slides.length - 1));
  setTrackPos(start);
  if (liveVertical() && start) {   // 그림이 늦게 뜨면 위치가 밀리니 다 뜬 뒤 한 번 더
    track.querySelectorAll('img').forEach(im => im.addEventListener('load', () => { if (V.pos[set.key] === start) setTrackPos(start); }, { once: true }));
  }
  let raf = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(updateLiveNow);
  }, { passive: true });
  updateLiveNow();
}

function switchLiveSetKey(key, at = 'keep') {
  const V = LiveState.viewing;
  const i = V ? V.sets.findIndex(st => st.key === key) : -1;
  if (i >= 0) switchLiveSet(i, at);
}

function switchLiveSet(i, at = 'keep') {
  const V = LiveState.viewing;
  if (!V || i < 0 || i >= V.sets.length) return;
  V.pos[V.sets[V.cur].key] = liveIndex();
  V.cur = i;
  const key = V.sets[i].key;
  if (at === 'first') V.pos[key] = 0;
  if (at === 'last') V.pos[key] = Math.max(0, liveSlides(V.sets[i]).length - 1);
  renderLiveSet();
}

/* 위 버튼 줄 접기/펼치기 — 기기마다 기억 (접으면 곡 제목과 ▾ 만 남는다) */
const LIVE_TOPMIN_KEY = 'jandi.live.topMin';
const liveTopMin = () => lsGet(LIVE_TOPMIN_KEY) === '1';
function toggleLiveTop() {
  lsSet(LIVE_TOPMIN_KEY, liveTopMin() ? '' : '1');
  const v = document.getElementById('liveViewer');
  v?.classList.toggle('top-min', liveTopMin());
  const b = v?.querySelector('.top-fold');
  if (b) {
    b.textContent = liveTopMin() ? '▾' : '▴';
    b.title = liveTopMin() ? '버튼 줄 펼치기' : '버튼 줄 접기';
    b.setAttribute('aria-label', b.title);
  }
}

/* ↔ 옆으로 넘기기 / ↕ 밑으로 스크롤 — 기기마다 기억 */
const LIVE_SCROLL_KEY = 'jandi.live.scroll';
const liveVertical = () => lsGet(LIVE_SCROLL_KEY) === 'v';
function toggleLiveScrollMode() {
  const i = liveIndex();
  lsSet(LIVE_SCROLL_KEY, liveVertical() ? 'h' : 'v');
  const V = LiveState.viewing;
  if (V?.sets[V.cur]) V.pos[V.sets[V.cur].key] = i;
  renderLiveSet();
  showToast(liveVertical() ? '↕ 밑으로 쭉 스크롤해서 봐요' : '↔ 옆으로 넘겨서 봐요', 'info', 1800);
}

function liveIndex() {
  const track = document.getElementById('liveTrack');
  if (!track) return 0;
  if (!track.classList.contains('vertical')) return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  // 세로: 화면 위쪽 1/3 지점에 걸친 쪽
  const y = track.scrollTop + track.clientHeight / 3;
  let idx = 0;
  [...track.children].forEach((el, i) => { if (el.offsetTop <= y) idx = i; });
  return idx;
}

/** i 번째 쪽으로 (세로면 그 쪽 맨 위로) */
function setTrackPos(i, smooth = false) {
  const track = document.getElementById('liveTrack');
  if (!track) return;
  const behavior = smooth ? 'smooth' : 'auto';
  if (track.classList.contains('vertical')) track.scrollTo({ top: track.children[i]?.offsetTop || 0, behavior });
  else track.scrollTo({ left: i * track.clientWidth, behavior });
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
  setTrackPos(n, true);
}

function updateLiveNow() {
  const slides = LiveState.slides || [];
  const V = LiveState.viewing;
  const i = liveIndex();
  const sl = slides[i];
  if (V && V.sets[V.cur]) V.pos[V.sets[V.cur].key] = i;
  if (!sl) return;
  document.getElementById('liveNow').innerHTML = `
    <strong>${sl.si + 1}. ${escapeHtml(sl.song.title)}</strong>
    ${sl.song.key ? `<span class="live-key">${escapeHtml(sl.song.key)}</span>` : ''}
    <span class="live-count">${sl.pages > 1 ? `${sl.pi + 1}/${sl.pages}쪽 · ` : ''}${i + 1} / ${slides.length}</span>`;
  document.querySelectorAll('.live-song-chip[data-live="jump"]').forEach((b, k) => b.classList.toggle('active', k === sl.si));
  document.querySelector('.live-song-chip.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function closeLiveViewer() {
  document.getElementById('liveMsg')?.remove();
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

/** 콘티 짜기와 같은 이름: 첫 곡 제목 (코드) · 곡 수 · 날짜 (builder.js 의 cbName) */
function contiDisplayName(c) {
  if (typeof cbName === 'function') return cbName(c);
  const d = c.conti_date ? `${c.conti_date} ` : '';
  return `${d}${c.title} · ${c.songs.length}곡`;
}

/* ── 라이브 화면에서 콘티 더하기: 관리자는 모두에게(함께 고치기), 팀원은 내 화면에만 ───── */
/** 콘티 이름·날짜·곡 제목으로 찾기. 곡 제목으로 찾으면 그 곡이 든 콘티들과 곡 이름을 같이 보여준다 */
function filterContisByQuery(contis, q) {
  const nq = normQ(q);
  return contis.map(c => {
    if (!nq) return { c, hits: [] };
    const hits = (c.songs || []).filter(s => normQ(s.title).includes(nq)).map(s => s.title);
    const own = normQ(`${c.title}${c.conti_date || ''}`).includes(nq);
    return own || hits.length ? { c, hits } : null;
  }).filter(Boolean);
}

async function openLiveAdd() {
  const box = document.getElementById('liveAdd');
  if (!box) return;
  document.getElementById('liveMsgPanel')?.classList.add('hidden');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="live-add-empty">불러오는 중...</p>';
  let contis = (typeof LibState !== 'undefined' && LibState.contis?.length) ? LibState.contis : null;
  if (!contis) { try { contis = await apiJson('/api/scores'); } catch { contis = []; } }
  contis = contis.filter(c => c.songs?.length);
  const setlist = (typeof LibState !== 'undefined' && LibState.setlist) || [];
  const V = LiveState.viewing;
  const shared = V && !V.local && LiveState.live?.can_edit;
  const inLive = new Set((V?.sets || []).map(st => st.conti_id).filter(Boolean));
  // 즐겨찾기 표시 (⭐❤️…) — 라이브러리 화면과 같은 것
  let marks = (typeof LibState !== 'undefined' && LibState.marks) || null;
  if (!marks || !Object.keys(marks).length) { try { marks = (await apiJson('/api/marks')).marks || {}; } catch { marks = {}; } }
  const mk = k => marks[k] || [];
  const markOfConti = c => mk(`conti:${c.id}`);
  const songMarks = s => mk(String(s.title || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, ''));
  const favSongs = [];   // 즐겨찾기한 곡 (제목 하나에 한 번)
  const seenSong = new Set();
  const groups = (typeof LibState !== 'undefined' && LibState.groups) || [];
  if (groups.length) {
    groups.filter(g => mk(g.key).length).forEach(g => { favSongs.push({ song: g.main, marks: mk(g.key) }); });
  } else {
    contis.forEach(c => c.songs.forEach(s => {
      const m = songMarks(s); const k = normQ(s.title);
      if (m.length && !seenSong.has(k)) { seenSong.add(k); favSongs.push({ song: s, marks: m }); }
    }));
  }
  box.innerHTML = `
    <p class="live-add-note">${shared ? '👥 더한 콘티는 <b>모두의 화면</b>에 같이 생겨요. <b>📣 띄우기</b>를 누르면 더하면서 모두의 화면을 그 콘티로 넘겨요.' : '내 화면에만 더해져요.'}</p>
    <input type="search" class="live-add-search" id="liveAddSearch" placeholder="콘티 이름·날짜·찬양 제목으로 찾기" />
    <div class="live-add-tempo" id="liveAddTempo"></div>
    <div class="live-add-list" id="liveAddList"></div>`;
  const notifyBtn = (attrs) => shared ? `<button type="button" class="live-add-notify" ${attrs} title="더하고 모두의 화면을 여기로 넘겨요">📣 띄우기</button>` : '';
  const contiRow = ({ c, hits }) => {
    const has = inLive.has(c.id);
    const m = markOfConti(c);
    return `<div class="live-add-row">
      <button type="button" class="live-add-item" data-live="add-conti" data-id="${c.id}" title="${escapeHtml(c.title)}" ${has ? 'disabled' : ''}>
        ${m.length ? `<b class="live-add-marks">${m.join('')}</b> ` : ''}${escapeHtml(contiDisplayName(c))}${has ? ' <small>✓ 이미 있음</small>' : ''}
        ${hits.length ? `<em class="live-add-hits">🎵 ${hits.map(escapeHtml).join(', ')}</em>` : ''}</button>
      ${notifyBtn(`data-live="add-conti-notify" data-id="${c.id}"`)}
    </div>`;
  };
  const songRow = ({ song, marks: m }) => `<div class="live-add-row">
      <button type="button" class="live-add-item" data-live="add-song" data-id="${song.id}" data-title="${escapeHtml(song.title)}">
        <b class="live-add-marks">${m.join('')}</b> 🎵 ${escapeHtml(song.title)}${song.key ? ` <small>${escapeHtml(song.key)}</small>` : ''}</button>
      ${notifyBtn(`data-live="add-song-notify" data-id="${song.id}" data-title="${escapeHtml(song.title)}"`)}
    </div>`;
  // 🐢 느린 곡 / 🐇 빠른 곡 고르기 (라이브러리 콘티 목록과 같은 기준: 그 빠르기 곡이 든 콘티)
  let tempo = '';
  const hasTempo = c => !tempo || c.songs.some(s => s.tempo === tempo);
  const TEMPOS = [['', '전체'], ['slow', '🐢 느린 곡'], ['fast', '🐇 빠른 곡']];
  const drawTempo = () => {
    document.getElementById('liveAddTempo').innerHTML = TEMPOS.map(([t, label]) => {
      const n = t ? contis.filter(c => c.songs.some(s => s.tempo === t)).length : null;
      return `<button type="button" class="live-to-chip all${tempo === t ? ' on' : ''}" data-tempo="${t}" aria-pressed="${tempo === t}">${label}${n === null ? '' : ` <small>${n}</small>`}</button>`;
    }).join('');
  };
  const draw = q => {
    const rows = filterContisByQuery(contis, q).filter(({ c }) => hasTempo(c));
    const favContis = q ? [] : contis.filter(c => markOfConti(c).length && hasTempo(c)).map(c => ({ c, hits: [] }));
    const nq = normQ(q);
    const favS = (q ? favSongs.filter(f => normQ(f.song.title).includes(nq)) : favSongs).filter(f => !tempo || f.song.tempo === tempo);
    document.getElementById('liveAddList').innerHTML = `
      ${!q && setlist.length ? `<button type="button" class="live-add-item" data-live="add-setlist">🎼 담은 곡 (${setlist.length}곡)</button>` : ''}
      ${favContis.length ? `<p class="live-add-head">⭐ 즐겨찾기 콘티</p>${favContis.map(contiRow).join('')}` : ''}
      ${favS.length ? `<p class="live-add-head">⭐ 즐겨찾기 곡</p>${favS.slice(0, 60).map(songRow).join('')}` : ''}
      ${!q && (favContis.length || favSongs.length) ? '<p class="live-add-head">📁 모든 콘티</p>' : ''}
      ${rows.slice(0, 80).map(contiRow).join('')
        || `<p class="live-add-empty">${tempo ? `${tempo === 'slow' ? '🐢 느린' : '🐇 빠른'} 곡이 든 콘티가 없어요.` : '찾는 콘티가 없어요.'}</p>`}`;
  };
  drawTempo();
  draw('');
  const input = document.getElementById('liveAddSearch');
  document.getElementById('liveAddTempo').addEventListener('click', e => {
    const b = e.target.closest('[data-tempo]');
    if (!b) return;
    tempo = b.dataset.tempo === tempo ? '' : b.dataset.tempo;
    drawTempo();
    draw(input.value.trim());
  });
  input.addEventListener('input', e => draw(e.target.value.trim()));
  input.focus({ preventScroll: true });
}

/** ✕ 라이브에서 콘티 빼기: 함께 보는 콘티면 서버에서(모두의 화면에서), 내 화면에만 더한 것이면 내 화면에서만 */
async function removeLiveSet(i) {
  const V = LiveState.viewing;
  const st = V?.sets[i];
  if (!st || V.sets.length <= 1) return;
  if (!st.mine && !V.local) {
    if (!confirm(`"${st.title}"을(를) 라이브에서 뺄까요?\n모두의 화면에서 빠져요.`)) return;
    try {
      const { live } = await apiJson(`/api/live/sets/${encodeURIComponent(st.key)}`, { method: 'DELETE' });
      LiveState.live = live;
      syncLiveViewer(live);
      showToast(`"${st.title}"을(를) 뺐어요.`, 'success');
    } catch (e) {
      showToast('콘티 빼기 실패: ' + e.message, 'error');
    }
    return;
  }
  if (V.sets[V.cur]) V.pos[V.sets[V.cur].key] = liveIndex();
  V.sets.splice(i, 1);
  V.cur = i < V.cur ? V.cur - 1 : Math.min(V.cur, V.sets.length - 1);   // 다른 탭을 빼면 보던 콘티 그대로
  renderLiveSet();
  showToast(`"${st.title}"을(를) 내 화면에서 뺐어요.`, 'success');
}

/** 고른 콘티를 더하기: 함께 보는 라이브면 서버에(모두에게), 아니면 내 화면에만 */
async function addLiveSet(set, notify = false) {
  const V = LiveState.viewing;
  if (!V || !set?.songs?.length) return;
  document.getElementById('liveAdd')?.classList.add('hidden');
  if (!V.local && LiveState.live?.can_edit) {
    try {
      // 이미 라이브에 있는 콘티면 더하지 않고 그 콘티로
      const existing = set.conti_id ? V.sets.find(st => !st.mine && st.conti_id === set.conti_id) : null;
      let key = existing?.key;
      if (!existing) {
        const { live, added_key } = await apiJson('/api/live/sets', jsonBody('POST', {
          title: set.title, conti_id: set.conti_id || null, song_ids: set.songs.map(s => s.id),
        }));
        LiveState.live = live;
        syncLiveViewerQuiet(live);
        key = added_key || [...live.sets].reverse().find(st => st.title === set.title)?.key;
      }
      if (key) switchLiveSetKey(key, 'first');
      if (notify && key) {
        const { live } = await apiJson('/api/live/focus', jsonBody('POST', { key, song: 0 }));
        setFocusSeen(live);
        applyLive(live);
        showToast(`📣 "${set.title}"을(를) 모두의 화면에 띄웠어요.`, 'success');
        return;
      }
      showToast(!existing ? `"${set.title}"을(를) 라이브에 더했어요. 모두의 화면에 보여요.` : '이미 라이브에 있는 콘티예요.', 'success');
    } catch (e) {
      showToast('콘티 더하기 실패: ' + e.message, 'error');
    }
    return;
  }
  V.sets.push({ ...set, key: `mine${Date.now()}`, mine: true });
  switchLiveSet(V.sets.length - 1, 'first');
}

/** 내가 바꾼 것은 "새 콘티" 알림 없이 맞춘다 */
function syncLiveViewerQuiet(live) {
  const V = LiveState.viewing;
  const curKey = V.sets[V.cur]?.key;
  V.pos[curKey] = liveIndex();
  V.sets = [...live.sets, ...V.sets.filter(st => st.mine)];
  V.rev = live.rev;
  V.cur = Math.max(0, V.sets.findIndex(st => st.key === curKey));
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

/* ── 💬 라이브 메세지 (관리자 → 라이브 보는 모두의 악보 위에, 터치하면 사라짐) ───── */
function msgSeenTs(live) {
  const [id, ts] = lsGet(LIVE_MSG_KEY).split(':');
  return live && id === String(live.id) ? Number(ts) || 0 : 0;
}
function setMsgSeen(live) {
  if (live?.message) lsSet(LIVE_MSG_KEY, `${live.id}:${live.message.ts}`);
}

/** 새 메세지면 띄운다. maxAge(ms) 를 주면 그보다 오래된 메세지는 띄우지 않고 본 것으로 */
function maybeShowLiveMessage(live, maxAge = 0) {
  const m = live?.message;
  if (!m || m.ts <= msgSeenTs(live)) return;
  setMsgSeen(live);
  if (maxAge && live.now_ms && live.now_ms - m.ts > maxAge) return;
  if (LiveState.sentMsgTs === m.ts) return;   // 내가 보낸 건 보낼 때 이미 띄웠음
  showLiveMessage(m.text, m.from);
}

/** sent 를 주면 "내가 보낸 메세지" — 받는 사람들에게 뜨는 모양 그대로 나한테도 보여준다 */
function showLiveMessage(text, from = '', sent = null) {
  document.getElementById('liveMsg')?.remove();
  const el = document.createElement('button');
  el.type = 'button';
  el.id = 'liveMsg';
  el.className = 'live-msg';
  el.innerHTML = `${from ? `<span class="live-msg-from">💬 ${escapeHtml(from)}</span>` : ''}<span class="live-msg-text">${escapeHtml(text)}</span><span class="live-msg-hint">3초 뒤 사라져요 · 터치하면 바로</span>`;
  if (sent) {
    el.classList.add('sent');
    el.insertAdjacentHTML('afterbegin', `<span class="live-msg-sent">✓ 보냈어요 · ${escapeHtml(sent)} 화면에 이렇게 떠요</span>`);
  }
  el.addEventListener('click', () => el.remove());
  // 터치 안 해도 3초 뒤 저절로 사라진다
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 3000);
  // 전체 화면이면 그 안에 붙여야 보인다
  (document.fullscreenElement || document.body).appendChild(el);
  if (!sent) try { navigator.vibrate?.([120, 60, 120]); } catch { /* 진동 없음 */ }
}

async function sendLiveMessage(text) {
  text = String(text || '').trim();
  if (!text) return;
  try {
    const to = msgTargets();
    if (to && !to.length) { showToast('받는 사람을 한 명 이상 골라주세요.', 'info'); return; }
    const { live } = await apiJson('/api/live/message', jsonBody('POST', { text, to }));
    LiveState.sentMsgTs = live.message.ts;
    setMsgSeen(live);
    document.getElementById('liveMsgPanel')?.classList.add('hidden');
    applyLive(live);
    const names = to ? LiveState.recipients.filter(x => to.includes(x.key)).map(x => x.name).join(', ') : '';
    showLiveMessage(live.message.text, live.message.from, names ? `${names}` : '모두의');
  } catch (e) {
    showToast('메세지 보내기 실패: ' + e.message, 'error');
  }
}

const QUICK_WORDS_FALLBACK = {
  who: ['베이스', '드럼', '메인신디', '2단 신디', '마이크', '1번', '2번', '3번', '4번', '5번', '사모님', '목사님'],
  what: ['조금만', '올려주세요', '내려주세요', '감사합니다'],
};

async function loadQuickMessages() {
  try {
    const r = await apiJson('/api/quick-messages');
    LiveState.quick = r.messages || [];
    LiveState.words = r.words || QUICK_WORDS_FALLBACK;
  } catch {
    LiveState.quick = LiveState.quick || [];
    LiveState.words = LiveState.words || QUICK_WORDS_FALLBACK;
  }
  return LiveState.quick;
}

const wordChips = list => list.map(w =>
  `<button type="button" class="live-word-chip" data-live="add-word" data-text="${escapeHtml(w)}">${escapeHtml(w)}</button>`).join('');

async function openLiveMsgPanel(edit = false) {
  const box = document.getElementById('liveMsgPanel');
  if (!box) return;
  if (!edit && !box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  document.getElementById('liveAdd')?.classList.add('hidden');
  box.classList.remove('hidden');
  const list = LiveState.quick && LiveState.words ? LiveState.quick : await loadQuickMessages();
  const words = LiveState.words || QUICK_WORDS_FALLBACK;
  if (edit) {
    box.innerHTML = `
      <p class="live-add-note">✏️ 퀵 메세지 편집 · 팀 관리자 모두 같이 써요</p>
      <div class="live-quick-edit" id="liveQuickEdit">
        ${list.map(m => `<div class="live-quick-row"><input type="text" class="live-add-search" maxlength="40" value="${escapeHtml(m)}" />
          <button type="button" class="live-top-btn" data-live="quick-del" aria-label="빼기">✕</button></div>`).join('')}
      </div>
      <div class="live-msg-actions"><button type="button" class="live-top-btn" data-live="quick-add">＋ 퀵 메세지 추가</button></div>
      <p class="live-add-note">🧩 단어 · 쉼표(,)로 나눠서 적어요</p>
      <label class="live-word-edit">누구·무엇
        <textarea class="live-add-search" id="liveWordsWho" rows="2">${escapeHtml(words.who.join(', '))}</textarea></label>
      <label class="live-word-edit">말
        <textarea class="live-add-search" id="liveWordsWhat" rows="2">${escapeHtml(words.what.join(', '))}</textarea></label>
      <div class="live-msg-actions">
        <button type="button" class="live-top-btn" data-live="msg-panel">취소</button>
        <button type="button" class="live-top-btn notify" data-live="quick-save">저장</button>
      </div>`;
    return;
  }
  await loadRecipients();
  const me = typeof AuthState !== 'undefined' && AuthState.name ? AuthState.name : (LiveState.live?.can_edit ? '관리자' : '');
  box.innerHTML = `
    <p class="live-add-note">⚡ 누르면 바로 라이브 보는 모두의 악보 위에 떠요${me ? ` · 보낸 사람: <b>${escapeHtml(me)}</b>` : ''}</p>
    <div class="live-quick">
      ${list.map(m => `<button type="button" class="live-quick-chip" data-live="send-msg" data-text="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('')}
    </div>
    <div class="live-to" id="liveTo">${recipientChips()}</div>
    <p class="live-add-note">🧩 단어를 눌러 문장을 만들고 <b>보내기</b></p>
    <div class="live-words">${wordChips(words.who)}</div>
    <div class="live-words what">${wordChips(words.what)}</div>
    <form class="live-msg-form" id="liveMsgForm">
      <input type="text" class="live-add-search" id="liveMsgInput" maxlength="80" placeholder="단어를 누르거나 직접 쓰기 (예: 2절 건너뛰어요)" />
      <button type="button" class="live-top-btn" data-live="word-back" title="마지막 단어 지우기" aria-label="마지막 단어 지우기">⌫</button>
      <button type="submit" class="live-top-btn notify">보내기</button>
    </form>
    ${LiveState.live?.can_edit ? '<button type="button" class="live-quick-editbtn" data-live="quick-edit">✏️ 퀵 메세지·단어 편집</button>' : ''}`;
  document.getElementById('liveMsgForm').addEventListener('submit', e => {
    e.preventDefault();
    sendLiveMessage(document.getElementById('liveMsgInput').value);
  });
}

/* ── 받는 사람 고르기 (기본은 전체, 눌러서 빼거나 한 사람만) ── */
async function loadRecipients() {
  if (LiveState.recipients) return;
  try {
    const r = await apiJson('/api/live/recipients');
    // 나는 빼고 (관리자·팀원 공용은 같은 코드를 쓰는 다른 사람이 있으니 그대로)
    LiveState.recipients = r.recipients.filter(x => x.key !== r.me || x.key === 'admin' || x.key === 'team');
  } catch { LiveState.recipients = []; }
  LiveState.msgTo = defaultRecipients();
}
/** 기본 받는 사람: "메세지 기본 제외"로 정한 사람(예: 목사님)은 빼고 */
const defaultRecipients = () => new Set((LiveState.recipients || []).filter(x => x.default !== false).map(x => x.key));

function recipientChips() {
  const list = LiveState.recipients || [];
  if (!list.length) return '';
  const to = LiveState.msgTo;
  const all = to.size === list.length;
  const def = defaultRecipients();
  const isDefault = !all && def.size === to.size && [...def].every(k => to.has(k));
  const left = list.filter(x => !to.has(x.key)).map(x => x.name);
  const open = !!LiveState.msgToOpen;
  // 평소엔 "받는 사람" 버튼 + 요약만, 누르면 사람 칩이 펼쳐진다
  return `<button type="button" class="live-to-toggle${open ? ' open' : ''}" data-live="to-open" aria-expanded="${open}">👥 받는 사람 ${open ? '▴' : '▾'}</button>
    <span class="live-to-sum">${all ? '모두에게 보여요' : !to.size ? '받는 사람을 골라주세요'
      : left.length <= 2 ? `${escapeHtml(left.join(', '))} 빼고 보여요${isDefault ? ' (기본)' : ''}` : `${to.size}명에게만 보여요`}</span>
    ${open ? `<div class="live-to-list">
      <button type="button" class="live-to-chip all${all ? ' on' : ''}" data-live="to-all">${all ? '✓ ' : ''}전체</button>
      ${list.map(x => `<button type="button" class="live-to-chip${to.has(x.key) ? ' on' : ''}" data-live="to-toggle" data-key="${escapeHtml(x.key)}"
        aria-pressed="${to.has(x.key)}">${to.has(x.key) ? '✓ ' : ''}${escapeHtml(x.name)}</button>`).join('')}
      ${!isDefault && def.size !== list.length ? '<button type="button" class="live-to-reset" data-live="to-default">↺ 기본으로</button>' : ''}
    </div>` : ''}`;
}

function toggleRecipient(key, all = false) {
  const list = LiveState.recipients || [];
  if (all) LiveState.msgTo = LiveState.msgTo.size === list.length ? new Set() : new Set(list.map(x => x.key));
  else if (LiveState.msgTo.has(key)) LiveState.msgTo.delete(key);
  else LiveState.msgTo.add(key);
  const box = document.getElementById('liveTo');
  if (box) box.innerHTML = recipientChips();
}

/** 보낼 대상: 전체면 null, 아니면 고른 사람들 (나 자신은 화면에 안 떠도 받는 것으로) */
function msgTargets() {
  const list = LiveState.recipients || [];
  if (!list.length || LiveState.msgTo.size === list.length) return null;
  return [...LiveState.msgTo];
}

function addMsgWord(word) {
  const input = document.getElementById('liveMsgInput');
  if (!input) return;
  const cur = input.value.replace(/\s+$/, '');
  input.value = (cur ? cur + ' ' : '') + word;
}

function removeMsgWord() {
  const input = document.getElementById('liveMsgInput');
  if (!input) return;
  const v = input.value.replace(/\s+$/, '');
  const words = LiveState.words || QUICK_WORDS_FALLBACK;
  // 누른 단어(띄어쓰기 들어간 "2단 신디"도)를 통째로 지우고, 아니면 마지막 낱말을 지운다
  const hit = [...words.who, ...words.what].sort((a, b) => b.length - a.length).find(w => v.endsWith(w));
  input.value = hit ? v.slice(0, v.length - hit.length).replace(/\s+$/, '') : v.replace(/\s*\S+$/, '');
}

const splitWords = v => String(v || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);

async function saveQuickMessages() {
  const messages = [...document.querySelectorAll('#liveQuickEdit input')].map(i => i.value.trim()).filter(Boolean);
  const words = { who: splitWords(document.getElementById('liveWordsWho')?.value), what: splitWords(document.getElementById('liveWordsWhat')?.value) };
  try {
    const r = await apiJson('/api/quick-messages', jsonBody('PUT', { messages, words }));
    LiveState.quick = r.messages;
    LiveState.words = r.words;
    showToast('퀵 메세지·단어를 저장했어요.', 'success');
    document.getElementById('liveMsgPanel')?.classList.add('hidden');
    openLiveMsgPanel(false);
  } catch (e) {
    showToast('저장 실패: ' + e.message, 'error');
  }
}

/* ── 이벤트 ─────────────────────────────────────────────── */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-live]');
  if (!el) return;
  switch (el.dataset.live) {
    case 'ok': {
      openLiveViewer();
      const live = LiveState.live;   // 알림주기 알림이었으면 그 콘티·곡으로
      if (live?.focus) { setFocusSeen(live); jumpToFocus(live); }
      break;
    }
    case 'open': openLiveViewer(); break;
    case 'ind-min': setLiveIndMinimized(true); break;
    case 'ind-expand': setLiveIndMinimized(false); break;
    case 'scroll-mode': toggleLiveScrollMode(); break;
    case 'invite': inviteLive(); break;
    case 'leave':
      if (LiveState.live?.mine && LiveState.viewerOpen && !LiveState.viewing?.local) openLeaveChoice();
      else leaveLive();
      break;
    case 'leave-only': document.getElementById('liveLeaveSheet')?.remove(); leaveLive(); break;
    case 'leave-cancel': document.getElementById('liveLeaveSheet')?.remove(); break;
    case 'msg': LiveState.msgToOpen = false; openLiveMsgPanel(); break;
    case 'to-open': LiveState.msgToOpen = !LiveState.msgToOpen; document.getElementById('liveTo').innerHTML = recipientChips(); break;
    case 'msg-panel': document.getElementById('liveMsgPanel')?.classList.add('hidden'); openLiveMsgPanel(); break;
    case 'send-msg': sendLiveMessage(el.dataset.text); break;
    case 'add-word': addMsgWord(el.dataset.text); break;
    case 'to-all': toggleRecipient(null, true); break;
    case 'to-default': LiveState.msgTo = defaultRecipients(); document.getElementById('liveTo').innerHTML = recipientChips(); break;
    case 'to-toggle': toggleRecipient(el.dataset.key); break;
    case 'word-back': removeMsgWord(); break;
    case 'quick-edit': openLiveMsgPanel(true); break;
    case 'quick-del': el.closest('.live-quick-row')?.remove(); break;
    case 'quick-add': {
      const row = document.createElement('div');
      row.className = 'live-quick-row';
      row.innerHTML = '<input type="text" class="live-add-search" maxlength="40" placeholder="새 퀵 메세지" /><button type="button" class="live-top-btn" data-live="quick-del" aria-label="빼기">✕</button>';
      document.getElementById('liveQuickEdit')?.appendChild(row);
      row.querySelector('input').focus();
      break;
    }
    case 'quick-save': saveQuickMessages(); break;
    case 'notify': notifyLive(); break;
    case 'paste': pickLivePhoto(); break;
    case 'song-x': removeLiveSong(Number(el.dataset.song)); break;
    case 'to-setlist': liveSetToSetlist(); break;
    case 'dismiss':
      if (LiveState.live) { setLiveSeen(LiveState.live.id); setFocusSeen(LiveState.live); setInviteSeen(LiveState.live); }
      hideLiveAlert();
      break;
    case 'close': closeLiveViewer(); break;
    case 'stop': stopLive(); break;
    case 'stop-now': stopLive(); break;
    case 'prev': stepLive(-1); break;
    case 'next': stepLive(1); break;
    case 'set': switchLiveSet(Number(el.dataset.set)); break;
    case 'remove-set': removeLiveSet(Number(el.dataset.set)); break;
    case 'fullscreen': toggleLiveFullscreen(); break;
    case 'add-set': openLiveAdd(); break;
    case 'add-conti':
    case 'add-conti-notify': {
      const c = (typeof LibState !== 'undefined' && LibState.contis || []).find(x => x.id === Number(el.dataset.id));
      const notify = el.dataset.live === 'add-conti-notify';
      liveSetFromConti(Number(el.dataset.id), c?.songs?.length ? contiDisplayName(c) : c?.title || el.closest('.live-add-row')?.querySelector('.live-add-item')?.textContent.trim() || '콘티')
        .then(set => addLiveSet(set, notify)).catch(err => showToast('불러오기 실패: ' + err.message, 'error'));
      break;
    }
    case 'add-song':
    case 'add-song-notify': {
      const notify = el.dataset.live === 'add-song-notify';
      liveSetFromSongIds([Number(el.dataset.id)], el.dataset.title || '곡')
        .then(set => addLiveSet(set, notify)).catch(err => showToast('불러오기 실패: ' + err.message, 'error'));
      break;
    }
    case 'top-fold': toggleLiveTop(); break;
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
  if (e.key === 'Escape') {
    if (document.getElementById('liveMsg')) { document.getElementById('liveMsg').remove(); return; }
    closeLiveViewer();
  }
});

/* 라이브 화면: 한 손가락으로 두 번 톡 → 확대 막기 (두 손가락 확대는 그대로) */
(() => {
  let lastTap = 0;
  document.addEventListener('touchend', e => {
    if (!LiveState.viewerOpen || !e.target.closest?.('#liveTrack')) return;
    if (e.touches.length || e.changedTouches.length !== 1) { lastTap = 0; return; }
    const now = Date.now();
    if (now - lastTap < 350) e.preventDefault();
    lastTap = now;
  }, { passive: false });
  document.addEventListener('dblclick', e => {
    if (LiveState.viewerOpen && e.target.closest?.('#liveViewer')) { e.preventDefault(); window.getSelection?.()?.removeAllRanges(); }
  });
  // 그림 길게 누르기·끌기로 움직이지 않게
  document.addEventListener('dragstart', e => { if (e.target.closest?.('#liveTrack')) e.preventDefault(); });
  document.addEventListener('contextmenu', e => { if (LiveState.viewerOpen && e.target.closest?.('#liveTrack img')) e.preventDefault(); });
})();

window.addEventListener('resize', () => {
  if (LiveState.viewerOpen) {
    const t = document.getElementById('liveTrack');
    const V = LiveState.viewing;
    if (t && V && V.sets[V.cur] && !t.classList.contains('vertical')) setTrackPos(V.pos[V.sets[V.cur].key] || 0);
  }
});

window.addEventListener('DOMContentLoaded', () => {
  (typeof AuthState !== 'undefined' ? AuthState.ready : Promise.resolve()).finally(startLivePolling);
});
