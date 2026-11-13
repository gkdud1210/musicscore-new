/**
 * 🕘 기록 — 라이브했던 콘티와 🎲 콘티 짜기로 짠 콘티가 모두 남는다 (서버, 최근 80개).
 * - 라이브는 시작·콘티 더하기·빼기 때마다 기록이 고쳐지고, ■ 종료해도 지워지지 않는다.
 * - ▶ 이어서 라이브: 그 콘티들로 라이브를 다시 시작 (진행 중인 라이브가 있으면 거기에 더하기).
 * - 👀 나만 보기 · 🎲 콘티 짜기로 불러오기(짠 콘티) · ✏️ 이름 · 🗑 지우기.
 * 사용자 데이터는 escapeHtml을 거쳐서만 innerHTML에 넣는다.
 */
const History = { list: [], filter: 'all' };

async function openHistory() {
  LibState.modal = { type: 'history' };
  showModal();
  document.getElementById('libModalBody').innerHTML = '<h2 class="lib-modal-title">🕘 기록</h2><p class="lib-modal-sub">불러오는 중...</p>';
  await loadHistory();
}

async function loadHistory() {
  try {
    History.list = (await apiJson('/api/history')).history || [];
  } catch (e) {
    History.list = [];
    showToast('기록 불러오기 실패: ' + e.message, 'error');
  }
  renderHistory();
}

/** 곡 id → { title, key } (콘티 목록에 있는 곡으로) */
function historySongMap() {
  const m = new Map();
  LibState.contis.forEach(c => (c.songs || []).forEach(s => m.set(s.id, s)));
  return m;
}

function historyWhen(h) {
  const d = new Date((h.live_ts || h.updated_ts || h.created_ts) * 1000);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} (${days[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderHistory() {
  if (LibState.modal?.type !== 'history') return;
  const body = document.getElementById('libModalBody');
  const list = History.list.filter(h => History.filter === 'all' || h.kind === History.filter);
  const songs = historySongMap();
  const count = k => History.list.filter(h => k === 'all' || h.kind === k).length;
  const tab = (k, label) => `<button type="button" class="btn-sm${History.filter === k ? ' active' : ''}" data-hist="filter" data-k="${k}">${label} ${count(k)}</button>`;
  body.innerHTML = `
    <h2 class="lib-modal-title">🕘 기록</h2>
    <p class="lib-modal-sub">라이브했던 콘티와 🎲 콘티 짜기로 짠 콘티가 여기 남아요. 라이브를 ■ 종료해도 지워지지 않고, ▶ 이어서 라이브로 다시 시작할 수 있어요.</p>
    <div class="hist-tabs">${tab('all', '전체')}${tab('live', '📡 라이브')}${tab('built', '🎲 짠 콘티')}</div>
    ${list.length ? `<ul class="ws-sets hist-list">${list.map(h => historyRowHtml(h, songs)).join('')}</ul>`
      : '<p class="ws-empty">아직 기록이 없어요. 라이브를 시작하거나 🎲 콘티 짜기로 콘티를 짜면 여기 남아요.</p>'}`;
}

function historyRowHtml(h, songs) {
  const state = h.live_now ? '<span class="hist-state on">🔴 진행 중</span>'
    : h.kind === 'live' ? `<span class="hist-state">${h.ended_ts ? '끝남' : '지난 라이브'}</span>` : '';
  const sets = h.sets.map(st => {
    const names = st.song_ids.map(id => songs.get(id)).filter(Boolean)
      .map(s => `${escapeHtml(s.title)}${s.key ? ` <b>${escapeHtml(s.key)}</b>` : ''}`);
    return `<div class="hist-set"><span class="hist-set-title">${escapeHtml(st.title)}</span>
      <span class="hist-set-songs">${names.length ? names.join(' · ') : `${st.song_ids.length}곡`}</span></div>`;
  }).join('');
  const canLoad = h.kind === 'built' && h.slots?.length;
  return `<li class="ws-set hist-row">
    <span class="hist-kind" title="${h.kind === 'live' ? '라이브' : '짠 콘티'}">${h.kind === 'live' ? '📡' : '🎲'}</span>
    <div class="ws-set-body">
      <div class="hist-head"><span class="ws-set-title">${escapeHtml(h.title)}</span>${state}</div>
      <div class="hist-meta">${escapeHtml(historyWhen(h))}${h.date ? ` · ${escapeHtml(dateLabel(h.date))}` : ''}${h.by ? ` · ${escapeHtml(h.by)}` : ''} · ${h.sets.length > 1 ? `콘티 ${h.sets.length}개 · ` : ''}${h.song_count}곡</div>
      ${sets}
      <div class="hist-actions">
        ${h.live_now
          ? `<button type="button" class="btn-now" data-hist="enter" data-id="${h.id}">🔴 들어가기</button>`
          : `<button type="button" class="btn-now" data-hist="resume" data-id="${h.id}">▶ ${h.kind === 'live' ? '이어서 라이브' : '라이브 시작'}</button>`}
        <button type="button" class="btn-sm" data-hist="preview" data-id="${h.id}">👀 나만 보기</button>
        ${canLoad ? `<button type="button" class="btn-sm" data-hist="builder" data-id="${h.id}">🎲 콘티 짜기로</button>` : ''}
        <button type="button" class="btn-sm" data-hist="rename" data-id="${h.id}" title="이름 바꾸기">✏️</button>
        <button type="button" class="btn-sm" data-hist="delete" data-id="${h.id}" title="기록 지우기">🗑</button>
      </div>
    </div>
  </li>`;
}

/** ▶ 이어서 라이브: 그 기록의 콘티들로 라이브 시작 (진행 중이면 그 라이브에 더하기) */
async function resumeHistory(h) {
  const running = LiveState.live;
  if (!confirm(running
    ? `지금 "${running.title}" 라이브가 진행 중이에요.\n새로 시작하지 않고, "${h.title}"의 콘티 ${h.sets.length}개를 그 라이브에 더할까요? (이미 있는 콘티는 빼고)`
    : `"${h.title}" 라이브를 다시 시작할까요?\n콘티 ${h.sets.length}개 · ${h.song_count}곡 · 접속한 모든 사람에게 알림이 가요.`)) return;
  try {
    const { live, joined } = await apiJson('/api/live', jsonBody('POST', {
      title: h.title, date: h.date || null, resume: h.id, sets: h.sets,
    }));
    setLiveSeen(live.id);
    lsSet(LIVE_LEFT_KEY, '');
    setFocusSeen(live);
    LiveState.live = live;
    renderLiveIndicator();
    closeModal(true);
    openLiveViewer();
    showToast(joined ? '진행 중인 라이브에 콘티를 더했어요. 모두의 화면에 같이 보여요.' : '📡 라이브를 다시 시작했어요! 접속한 사람들에게 알림을 보냈어요.', 'success');
  } catch (e) {
    showToast('라이브 시작 실패: ' + e.message, 'error');
  }
}

async function previewHistory(h) {
  try {
    const sets = await Promise.all(h.sets.map(st => liveSetFromSongIds(st.song_ids, st.title)));
    const shown = sets.filter(st => st.songs.length);
    if (!shown.length) { showToast('이 기록의 곡들이 지금은 없어요 (지워졌을 수 있어요).', 'info'); return; }
    closeModal(true);
    openLiveViewer({ id: `local-hist-${h.id}`, title: h.title, sets: shown });
  } catch (e) {
    showToast('불러오기 실패: ' + e.message, 'error');
  }
}

/** 짠 콘티 → 🎲 콘티 짜기에 그 칸들 그대로 */
function historyToBuilder(h) {
  Builder.slots = h.slots.map(s => ({ cat: s.cat, id: s.id }));
  cbSave();
  closeModal(true);
  openContiBuilder();
  const gone = h.slots.filter(s => !LibState.contis.some(c => c.id === s.id && c.combo)).length;
  if (gone) showToast(`배합 ${gone}개가 지금은 없어서 그 칸은 새로 골랐어요.`, 'info', 4000);
}

/** 🎲 콘티 짜기에서 짠 콘티를 기록에 남긴다 (같은 곡이면 하나로) */
async function recordBuiltConti(title, quiet = true) {
  const filled = cbFilled();
  if (!filled.length) return null;
  const sets = filled.map(({ s, c }) => ({
    title: cbLabel(s.cat).replace(/^\S+\s/, ''), conti_id: c.id,
    song_ids: [...c.songs].sort((a, b) => a.page_start - b.page_start).map(x => x.id),
  }));
  const name = title || filled.map(({ c }) => c.songs[0]?.title).filter(Boolean).join(' / ').slice(0, 80) || '짠 콘티';
  try {
    const r = await apiJson('/api/history', jsonBody('POST', {
      title: name, sets, slots: Builder.slots.map(s => ({ cat: s.cat, id: s.id })),
    }));
    if (!quiet) showToast(r.same ? '이미 기록에 있는 콘티예요. 맨 위로 올렸어요.' : '🕘 기록에 남겼어요.', 'success');
    return r.history;
  } catch (e) {
    if (!quiet) showToast('기록 실패: ' + e.message, 'error');
    return null;
  }
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-hist]');
  if (!el || el.disabled) return;
  const act = el.dataset.hist;
  if (act === 'open') { openHistory(); return; }
  if (LibState.modal?.type !== 'history') return;
  if (act === 'filter') { History.filter = el.dataset.k; renderHistory(); return; }
  const h = History.list.find(x => x.id === Number(el.dataset.id));
  if (!h) return;
  switch (act) {
    case 'resume': resumeHistory(h); break;
    case 'enter': closeModal(true); openLiveViewer(); break;
    case 'preview': previewHistory(h); break;
    case 'builder': historyToBuilder(h); break;
    case 'rename': {
      const t = prompt('기록 이름', h.title);
      if (t === null || !t.trim()) return;
      try {
        const r = await apiJson(`/api/history/${h.id}`, jsonBody('PATCH', { title: t.trim() }));
        Object.assign(h, r.history);
        renderHistory();
      } catch (err) { showToast('이름 바꾸기 실패: ' + err.message, 'error'); }
      break;
    }
    case 'delete':
      if (!confirm(`"${h.title}" 기록을 지울까요?\n(콘티·악보는 그대로예요. 이 기록만 지워져요)`)) return;
      try {
        await apiJson(`/api/history/${h.id}`, { method: 'DELETE' });
        History.list = History.list.filter(x => x !== h);
        renderHistory();
      } catch (err) { showToast('지우기 실패: ' + err.message, 'error'); }
      break;
  }
});
