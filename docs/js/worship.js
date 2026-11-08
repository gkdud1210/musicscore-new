/**
 * 예배 라이브 셋팅
 * - 날짜를 고르고, 그날 볼 콘티들을 순서대로 담는다 (콘티 목록에서 / 담은 곡에서).
 * - 💾 저장하면 그 날짜에 남아서 다음에 열면 그대로 (관리자).
 * - ▶ 라이브 시작: 접속한 모두에게 알림 + 라이브 화면. 위 메뉴(탭)에서 콘티를 오가며 본다.
 * - 👀 나만 보기: 알림 없이 내 화면에서만 같은 라이브 화면.
 * 사용자 데이터는 escapeHtml을 거쳐서만 innerHTML에 넣는다.
 */

const Worship = { date: '', title: '', sets: [], saved: null, services: [], dirty: false, q: '' };

function isoDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 오늘이 일요일이면 오늘, 아니면 다가오는 일요일 */
function defaultServiceDate() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return isoDate(d);
}

function dateLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

function defaultServiceTitle(iso) {
  const d = new Date(iso + 'T00:00:00');
  const kind = d.getDay() === 0 ? '주일예배' : d.getDay() === 5 ? '금요예배' : d.getDay() === 3 ? '수요예배' : '예배';
  return `${dateLabel(iso).replace(/ \(.\)$/, '')} ${kind}`;
}

/* ── 열기 / 날짜 바꾸기 ───────────────────────────────── */
async function openWorshipSetup(date = null) {
  LibState.modal = { type: 'worship' };
  showModal();
  document.getElementById('libModalBody').innerHTML = '<p class="lib-modal-sub">불러오는 중...</p>';
  try {
    Worship.services = (await apiJson('/api/services')).services || [];
  } catch { Worship.services = []; }
  await loadWorshipDate(date || defaultServiceDate());
}

async function loadWorshipDate(date) {
  Worship.date = date;
  Worship.dirty = false;
  let saved = null;
  try { saved = (await apiJson(`/api/services/${date}`)).service; } catch { saved = null; }
  Worship.saved = saved;
  if (saved?.sets?.length) {
    Worship.title = saved.title || defaultServiceTitle(date);
    Worship.sets = await Promise.all(saved.sets.map(resolveSavedSet));
    Worship.sets = Worship.sets.filter(st => st.songs.length);
  } else {
    // 저장된 셋팅이 없으면 그 날짜의 콘티들을 먼저 넣어둔다
    Worship.title = defaultServiceTitle(date);
    Worship.sets = LibState.contis.filter(c => c.conti_date === date && c.songs.length).map(contiToSet);
    Worship.dirty = Worship.sets.length > 0;
  }
  renderWorshipSetup();
}

function contiToSet(c) {
  return {
    title: c.title, conti_id: c.id,
    songs: [...c.songs].sort((a, b) => a.page_start - b.page_start).map(s => ({ id: s.id, title: s.title, key: s.key })),
  };
}

/** 저장된 묶음 → 화면용. 콘티에서 온 묶음은 지금 콘티의 곡 순서를 쓴다 (곡 나누기를 고쳤어도 맞게) */
async function resolveSavedSet(st) {
  const c = st.conti_id ? LibState.contis.find(x => x.id === st.conti_id) : null;
  if (c && c.songs.length) return { ...contiToSet(c), title: st.title || c.title };
  const songs = await Promise.all((st.song_ids || []).map(id =>
    apiJson(`/api/songs/${id}`).then(s => ({ id: s.id, title: s.title, key: s.key })).catch(() => null)));
  return { title: st.title, conti_id: null, songs: songs.filter(Boolean) };
}

/* ── 그리기 ───────────────────────────────────────────── */
function renderWorshipSetup() {
  const W = Worship;
  const canSave = AuthState.canEdit;
  const sameDay = LibState.contis.filter(c => c.conti_date === W.date && c.songs.length);
  const inSets = new Set(W.sets.map(st => st.conti_id).filter(Boolean));
  const q = W.q.trim();
  // ⭐ 즐겨찾기(표시를 붙인) 콘티는 맨 위에 전부
  const favs = LibState.contis.filter(c => c.songs.length && marksOf(contiMarkKey(c.id)).length);
  const favIds = new Set(favs.map(c => c.id));
  // 콘티 이름·날짜뿐 아니라 찬양 제목으로도 찾는다 (그 곡이 든 콘티들)
  const others = filterContisByQuery(
    LibState.contis.filter(c => c.songs.length && c.conti_date !== W.date && (q || !favIds.has(c.id))), q)
    .slice(0, q ? 60 : 12);
  const upcoming = W.services.filter(s => s.sets?.length).slice(0, 8);
  const totalSongs = W.sets.reduce((n, st) => n + st.songs.length, 0);

  const contiRow = (c, hits = []) => `
    <div class="ws-pick-row">
      <span class="ws-pick-name">${marksOf(contiMarkKey(c.id)).length ? `<span class="card-marks">${marksOf(contiMarkKey(c.id)).join('')}</span> ` : ''}${c.conti_date ? `<span class="ws-date">${escapeHtml(c.conti_date)}</span>` : ''}${escapeHtml(c.title)}
        <small>${c.songs.length}곡</small>${hits.length ? `<em class="ws-hits">🎵 ${hits.map(escapeHtml).join(', ')}</em>` : ''}</span>
      <button type="button" class="btn-sm" data-ws="add-conti" data-id="${c.id}" ${inSets.has(c.id) ? 'disabled' : ''}>
        ${inSets.has(c.id) ? '✓ 담김' : '＋ 추가'}</button>
    </div>`;

  document.getElementById('libModalBody').innerHTML = `
    <h2 class="lib-modal-title">🎤 예배 라이브 셋팅</h2>
    <p class="lib-modal-sub">날짜를 고르고 그날 볼 콘티들을 순서대로 담아요. 라이브 화면 위 메뉴에서 콘티를 자유롭게 오갈 수 있어요.</p>

    <div class="ws-head">
      <label class="ws-field"><span>날짜</span>
        <input type="date" class="lib-edit-title-input" id="wsDate" value="${escapeHtml(W.date)}" /></label>
      <label class="ws-field ws-grow"><span>예배 이름</span>
        <input type="text" class="lib-edit-title-input" id="wsTitle" value="${escapeHtml(W.title)}" /></label>
    </div>
    ${upcoming.length ? `<div class="ws-saved">
      <span class="ws-saved-label">저장된 셋팅</span>
      ${upcoming.map(s => `<button type="button" class="lib-chord-chip${s.date === W.date ? ' active' : ''}" data-ws="date" data-date="${s.date}">
        ${escapeHtml(dateLabel(s.date))} · ${s.sets.length}콘티</button>`).join('')}
    </div>` : ''}

    <h3 class="song-section-title">📋 이 날 볼 콘티 <span>${W.sets.length}</span>
      ${W.saved && !W.dirty ? '<small class="ws-state ok">저장됨</small>' : W.sets.length ? '<small class="ws-state">아직 저장 안 됨</small>' : ''}</h3>
    ${W.sets.length ? `<ol class="ws-sets">
      ${W.sets.map((st, i) => `
        <li class="ws-set">
          <span class="ws-set-no">${i + 1}</span>
          <div class="ws-set-body">
            <input type="text" class="lib-edit-title-input ws-set-title" data-ws-title="${i}" value="${escapeHtml(st.title)}" aria-label="콘티 이름" />
            <div class="conti-songs">${st.songs.map((s, k) => `<span class="conti-song-chip">${k + 1}. ${escapeHtml(s.title)}${s.key ? ` <b>${escapeHtml(s.key)}</b>` : ''}</span>`).join('')}</div>
          </div>
          <div class="ws-set-tools">
            <button type="button" class="btn-sm" data-ws="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="위로">▲</button>
            <button type="button" class="btn-sm" data-ws="down" data-i="${i}" ${i === W.sets.length - 1 ? 'disabled' : ''} aria-label="아래로">▼</button>
            <button type="button" class="btn-sm" data-ws="remove" data-i="${i}" aria-label="빼기">✕</button>
          </div>
        </li>`).join('')}
    </ol>` : '<p class="ws-empty">아래에서 콘티를 추가해주세요.</p>'}

    <div class="ws-actions">
      ${canSave ? `<button type="button" class="btn-sm" data-ws="save" ${W.sets.length ? '' : 'disabled'}>💾 셋팅 저장</button>` : ''}
      <button type="button" class="btn-sm" data-ws="preview" ${W.sets.length ? '' : 'disabled'}>👀 나만 보기</button>
      <button type="button" class="btn-now" data-ws="start" ${W.sets.length ? '' : 'disabled'}>📡 ${LiveState.live ? '진행 중인 라이브에 더하기' : '라이브 시작'} · ${W.sets.length}콘티 ${totalSongs}곡</button>
    </div>

    <h3 class="song-section-title">＋ 콘티 추가</h3>
    ${favs.length ? `<p class="ws-sub">⭐ 즐겨찾기 콘티 <small>${favs.length}</small></p><div class="ws-favs">${favs.map(c => contiRow(c)).join('')}</div>` : ''}
    ${sameDay.length ? `<p class="ws-sub">📅 ${escapeHtml(dateLabel(W.date))} 콘티</p>${sameDay.map(c => contiRow(c)).join('')}` : ''}
    ${LibState.setlist.length ? `<div class="ws-pick-row">
      <span class="ws-pick-name">🎼 지금 담은 곡 <small>${LibState.setlist.length}곡</small></span>
      <button type="button" class="btn-sm" data-ws="add-setlist">＋ 추가</button></div>` : ''}
    <input type="search" class="lib-edit-title-input ws-search" id="wsSearch" value="${escapeHtml(W.q)}" placeholder="다른 콘티 찾기 (이름·날짜·찬양 제목)" />
    <div class="ws-pick">${others.map(({ c, hits }) => contiRow(c, hits)).join('') || '<p class="ws-empty">찾는 콘티가 없어요.</p>'}</div>`;

  document.getElementById('wsDate').addEventListener('change', e => {
    if (!e.target.value) return;
    if (Worship.dirty && Worship.sets.length && !confirm('저장 안 한 셋팅이 있어요. 날짜를 바꿀까요?')) { e.target.value = Worship.date; return; }
    loadWorshipDate(e.target.value);
  });
  document.getElementById('wsTitle').addEventListener('input', e => { Worship.title = e.target.value; markWorshipDirty(); });
  document.getElementById('wsSearch').addEventListener('input', e => {
    Worship.q = e.target.value;
    const pos = e.target.selectionStart;
    renderWorshipSetup();
    const el = document.getElementById('wsSearch');
    el.focus();
    el.setSelectionRange(pos, pos);
  });
  document.querySelectorAll('[data-ws-title]').forEach(inp => inp.addEventListener('input', e => {
    Worship.sets[Number(e.target.dataset.wsTitle)].title = e.target.value;
    markWorshipDirty();
  }));
}

function markWorshipDirty() {
  Worship.dirty = true;
  const st = document.querySelector('.ws-state');
  if (st) { st.textContent = '아직 저장 안 됨'; st.classList.remove('ok'); }
}

function changeWorship(fn) {
  fn(Worship.sets);
  Worship.dirty = true;
  renderWorshipSetup();
}

/* ── 저장 / 시작 ──────────────────────────────────────── */
function worshipPayload() {
  return {
    title: Worship.title.trim() || defaultServiceTitle(Worship.date),
    sets: Worship.sets.map(st => ({ title: st.title.trim() || '콘티', conti_id: st.conti_id || null, song_ids: st.songs.map(s => s.id) })),
  };
}

async function saveWorship(quiet = false) {
  try {
    const { service } = await apiJson(`/api/services/${Worship.date}`, jsonBody('PUT', worshipPayload()));
    Worship.saved = service;
    Worship.dirty = false;
    const i = Worship.services.findIndex(s => s.date === service.date);
    if (i >= 0) Worship.services[i] = service; else Worship.services.unshift(service);
    Worship.services.sort((a, b) => b.date.localeCompare(a.date));
    if (!quiet) showToast(`${dateLabel(Worship.date)} 셋팅을 저장했어요.`, 'success');
    if (LibState.modal?.type === 'worship') renderWorshipSetup();
    return true;
  } catch (e) {
    showToast('저장 실패: ' + e.message, 'error');
    return false;
  }
}

async function startWorshipLive() {
  const p = worshipPayload();
  const running = LiveState.live;
  if (!confirm(running
    ? `지금 "${running.title}" 라이브가 진행 중이에요.\n새로 시작하지 않고, 이 콘티 ${p.sets.length}개를 그 라이브에 더할까요? (이미 있는 콘티는 빼고)`
    : `"${p.title}" 라이브를 시작할까요?\n콘티 ${p.sets.length}개 · 접속한 모든 사람에게 알림이 가요.`)) return;
  if (AuthState.canEdit && Worship.dirty) await saveWorship(true);
  try {
    const { live, joined } = await apiJson('/api/live', jsonBody('POST', { ...p, date: Worship.date }));
    setLiveSeen(live.id);
    lsSet(LIVE_LEFT_KEY, '');
    setFocusSeen(live);
    LiveState.live = live;
    renderLiveIndicator();
    closeModal(true);
    openLiveViewer();
    showToast(joined ? '진행 중인 라이브에 콘티를 더했어요. 모두의 화면에 같이 보여요.' : '📡 라이브 시작! 접속한 사람들에게 알림을 보냈어요.', 'success');
  } catch (e) {
    showToast('라이브 시작 실패: ' + e.message, 'error');
  }
}

async function previewWorship() {
  try {
    const sets = await Promise.all(Worship.sets.map(st => st.conti_id
      ? liveSetFromConti(st.conti_id, st.title)
      : liveSetFromSongIds(st.songs.map(s => s.id), st.title)));
    closeModal(true);
    openLiveViewer({ id: `local-${Worship.date}`, title: Worship.title, sets: sets.filter(st => st.songs.length) });
  } catch (e) {
    showToast('불러오기 실패: ' + e.message, 'error');
  }
}

/* ── 이벤트 ───────────────────────────────────────────── */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-ws]');
  if (!el) return;
  const i = Number(el.dataset.i);
  switch (el.dataset.ws) {
    case 'open': openWorshipSetup(); break;
    case 'date':
      if (Worship.dirty && Worship.sets.length && !confirm('저장 안 한 셋팅이 있어요. 날짜를 바꿀까요?')) return;
      loadWorshipDate(el.dataset.date);
      break;
    case 'add-conti': {
      const c = LibState.contis.find(x => x.id === Number(el.dataset.id));
      if (c) changeWorship(sets => sets.push(contiToSet(c)));
      break;
    }
    case 'add-setlist':
      changeWorship(sets => sets.push({
        title: document.getElementById('setlistTitle')?.value.trim() || '새 콘티',
        conti_id: null, songs: LibState.setlist.map(s => ({ id: s.id, title: s.title, key: s.key })),
      }));
      break;
    case 'up': changeWorship(sets => sets.splice(i - 1, 0, ...sets.splice(i, 1))); break;
    case 'down': changeWorship(sets => sets.splice(i + 1, 0, ...sets.splice(i, 1))); break;
    case 'remove': changeWorship(sets => sets.splice(i, 1)); break;
    case 'save': saveWorship(); break;
    case 'start': startWorshipLive(); break;
    case 'preview': previewWorship(); break;
  }
});
