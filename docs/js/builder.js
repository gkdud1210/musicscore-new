/**
 * 🎲 콘티 짜기 — 배합 콘티(설교 전 느린 곡 · 설교 전 빠른 곡 · 설교 후 느린 곡 …)를 칸마다 하나씩 골라 콘티 하나로.
 * - 처음 열면 칸마다 배합을 하나씩 골라 바로 보여준다 (고른 것은 이 기기에 기억)
 * - 🔄 다른 배합: 그 칸만 바꾸기 · 목록에서 직접 고르기 · 칸 빼기/더하기
 * - 나만 보기 / NOW 라이브 / 새 콘티에 담기 / (관리자) 콘티로 저장
 * - 짠 콘티는 위 버튼을 누르거나 🕘 기록에 남기기를 누르면 서버의 🕘 기록에 남는다 (history.js)
 */
const CB_KEY = 'jandi.builder';
const CB_CATS = [
  ['before|slow', '🙏🐢 설교 전 느린 곡'],
  ['before|fast', '🙏🐇 설교 전 빠른 곡'],
  ['after|slow', '🕊🐢 설교 후 느린 곡'],
  ['after|fast', '🕊🐇 설교 후 빠른 곡'],
  ['|slow', '🐢 느린 곡 (설교 전/후 안 고름)'],
  ['|fast', '🐇 빠른 곡 (설교 전/후 안 고름)'],
];
const CB_DEFAULT = ['before|slow', 'before|fast', 'after|slow'];
const cbLabel = cat => (CB_CATS.find(c => c[0] === cat) || [cat, cat])[1];
const cbCatOf = c => c.songs?.length ? `${c.songs[0].section}|${c.songs[0].tempo}` : '';

const Builder = { slots: [] };   // [{ cat, id }]

function cbLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(CB_KEY) || 'null');
    if (Array.isArray(v) && v.every(s => s && typeof s.cat === 'string')) return v;
  } catch { /* 없음 */ }
  return null;
}
function cbSave() {
  try { localStorage.setItem(CB_KEY, JSON.stringify(Builder.slots)); } catch { /* 저장 불가 */ }
}

/** 그 분류의 배합들 (최근 날짜 먼저) */
function cbCombos(cat) {
  return LibState.contis.filter(c => c.combo && cbCatOf(c) === cat)
    .sort((a, b) => String(b.conti_date || '').localeCompare(String(a.conti_date || '')) || b.id - a.id);
}

/** 그 칸에 다른 배합 하나 (지금 것·다른 칸에 쓴 것은 피해서, 없으면 아무거나) */
function cbPick(cat, avoid = []) {
  const list = cbCombos(cat);
  if (!list.length) return null;
  const fresh = list.filter(c => !avoid.includes(c.id));
  const pool = fresh.length ? fresh : list;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

function cbUsedIds(except = -1) {
  return Builder.slots.filter((_, i) => i !== except).map(s => s.id).filter(Boolean);
}

/** 콘티 짜기 열기. fresh 면 칸마다 새로 고른다 */
function openContiBuilder(fresh = false) {
  const saved = fresh ? null : cbLoad();
  Builder.slots = saved || CB_DEFAULT.map(cat => ({ cat, id: null }));
  // 지워졌거나 비어 있는 칸은 새로 고르기
  Builder.slots.forEach((s, i) => {
    if (!s.id || !LibState.contis.some(c => c.id === s.id && c.combo)) s.id = cbPick(s.cat, cbUsedIds(i));
  });
  cbSave();
  LibState.modal = { type: 'builder' };
  showModal();
  renderContiBuilder();
}

function renderContiBuilder() {
  if (LibState.modal?.type !== 'builder') return;
  const body = document.getElementById('libModalBody');
  const total = Builder.slots.reduce((n, s) => n + (LibState.contis.find(c => c.id === s.id)?.songs.length || 0), 0);
  const free = CB_CATS.filter(([cat]) => cbCombos(cat).length);
  body.innerHTML = `
    <h2 class="lib-modal-title">🎲 콘티 짜기</h2>
    <p class="lib-modal-sub">배합을 칸마다 하나씩 골라 콘티를 만들어요. 마음에 안 드는 칸만 🔄 다른 배합으로 바꿔보세요.</p>
    <div class="cb-slots">
      ${Builder.slots.map((s, i) => cbSlotHtml(s, i)).join('')}
    </div>
    <div class="cb-add-row">
      ${free.map(([cat, label]) => `<button type="button" class="btn-sm" data-cb="add" data-cat="${cat}">＋ ${label}</button>`).join('')}
    </div>
    <div class="cb-actions">
      <span class="cb-total">모두 ${total}곡</span>
      <button type="button" class="btn-sm" data-cb="reroll-all">🎲 전부 다시 고르기</button>
      <button type="button" class="btn-sm" data-cb="preview"${total ? '' : ' disabled'}>👀 나만 보기</button>
      <button type="button" class="btn-sm" data-cb="setlist"${total ? '' : ' disabled'}>＋ 새 콘티에 담기</button>
      ${AuthState.server === 'php' ? `<button type="button" class="btn-sm" data-cb="record"${total ? '' : ' disabled'} title="짠 콘티를 🕘 기록에 남겨요 (나중에 다시 불러오거나 라이브 시작)">🕘 기록에 남기기</button>` : ''}
      ${AuthState.canEdit && AuthState.server === 'php' ? `<button type="button" class="btn-sm" data-cb="save"${total ? '' : ' disabled'}>💾 콘티로 저장</button>` : ''}
      <button type="button" class="btn-now" data-cb="live"${total ? '' : ' disabled'}>📡 NOW 라이브</button>
    </div>`;
}

function cbSlotHtml(s, i) {
  const list = cbCombos(s.cat);
  const c = LibState.contis.find(x => x.id === s.id);
  const head = `<div class="cb-slot-head">
      <span class="cb-slot-no">${i + 1}</span><b>${cbLabel(s.cat)}</b>
      <span class="cb-slot-count">배합 ${list.length}개</span>
      <span class="cb-slot-tools">
        ${i > 0 ? `<button type="button" class="btn-sm" data-cb="up" data-i="${i}" title="앞으로" aria-label="앞으로">▲</button>` : ''}
        ${i < Builder.slots.length - 1 ? `<button type="button" class="btn-sm" data-cb="down" data-i="${i}" title="뒤로" aria-label="뒤로">▼</button>` : ''}
        <button type="button" class="btn-sm" data-cb="remove" data-i="${i}" title="이 칸 빼기" aria-label="이 칸 빼기">✕</button>
      </span>
    </div>`;
  if (!list.length) {
    return `<div class="cb-slot empty">${head}<p class="lib-chord-empty">이 분류의 배합이 아직 없어요. 콘티를 열어 곡마다 분류를 고르고 🧩 배합 만들기를 눌러주세요.</p></div>`;
  }
  return `<div class="cb-slot">${head}
    <div class="cb-slot-pick">
      <select class="lib-edit-title-input cb-select" data-cb-select="${i}" aria-label="${cbLabel(s.cat)} 고르기">
        ${list.map(x => `<option value="${x.id}"${x.id === s.id ? ' selected' : ''}>${escapeHtml(cbName(x))}</option>`).join('')}
      </select>
      <button type="button" class="btn-sm cb-reroll" data-cb="reroll" data-i="${i}"${list.length > 1 ? '' : ' disabled'}>🔄 다른 배합</button>
      ${c ? `<button type="button" class="btn-sm" data-action="open-conti" data-id="${c.id}" title="이 배합 열어보기">📄</button>` : ''}
    </div>
    <div class="conti-songs">${c ? c.songs.map((x, k) => `<span class="conti-song-chip">${k + 1}. ${escapeHtml(x.title)}${x.key ? ` <b>${escapeHtml(x.key)}</b>` : ''}</span>`).join('') : ''}</div>
  </div>`;
}

/** 콘티 짜기에서 보이는 배합 이름: 첫 곡 제목 (코드) · 곡 수 · 날짜 — 예) "은혜 아니면 (G → A) · 2곡 · 11/6" */
function cbName(c) {
  const first = c.songs[0]?.title || '제목 없음';
  const keys = [];
  c.songs.forEach(x => { if (x.key && keys[keys.length - 1] !== x.key) keys.push(x.key); });
  const d = c.conti_date ? ` · ${Number(c.conti_date.slice(5, 7))}/${Number(c.conti_date.slice(8, 10))}` : '';
  return `${first}${keys.length ? ` (${keys.join(' → ')})` : ''} · ${c.songs.length}곡${d}`;
}

/** "설교 전 느린 곡 — 6월13일금요일" → "6월13일금요일" (이름에 날짜가 없으면 날짜를 붙여서) */
function cbSource(c) {
  const name = String(c.title || '').split(' — ').slice(1).join(' — ') || String(c.title || '');
  return c.conti_date && !/\d+월/.test(name) ? `${name} (${c.conti_date})` : name;
}

/** 배합이 고른 칸만, 순서대로 [{ s: 칸, c: 배합 콘티 }] */
function cbFilled() {
  return Builder.slots.map(s => ({ s, c: LibState.contis.find(x => x.id === s.id) })).filter(x => x.c);
}

async function cbSongs() {
  const parts = await Promise.all(cbFilled().map(({ c }) => apiJson(`/api/songs?score_id=${c.id}`)
    .then(list => list.sort((a, b) => a.page_start - b.page_start))));
  return parts.flat();
}

/** 짠 콘티를 쓰면(보기·라이브·담기·저장) 🕘 기록에도 남긴다 */
function cbRecord(title) {
  if (AuthState.server === 'php' && typeof recordBuiltConti === 'function') recordBuiltConti(title);
}

async function cbAction(act, el) {
  const i = Number(el?.dataset.i);
  if (['preview', 'live', 'setlist'].includes(act)) cbRecord();
  switch (act) {
    case 'record': recordBuiltConti(null, false); return;
    case 'reroll': Builder.slots[i].id = cbPick(Builder.slots[i].cat, [Builder.slots[i].id, ...cbUsedIds(i)]); break;
    case 'reroll-all': Builder.slots.forEach((s, k) => { s.id = cbPick(s.cat, [s.id, ...cbUsedIds(k)]); }); break;
    case 'remove': Builder.slots.splice(i, 1); break;
    case 'up': [Builder.slots[i - 1], Builder.slots[i]] = [Builder.slots[i], Builder.slots[i - 1]]; break;
    case 'down': [Builder.slots[i + 1], Builder.slots[i]] = [Builder.slots[i], Builder.slots[i + 1]]; break;
    case 'add': Builder.slots.push({ cat: el.dataset.cat, id: cbPick(el.dataset.cat, cbUsedIds()) }); break;
    case 'preview':
      try {
        const sets = await Promise.all(cbFilled().map(({ s, c }) => liveSetFromConti(c.id, cbLabel(s.cat).replace(/^\S+\s/, ''))));
        closeModal(true);
        openLiveViewer({ id: 'local-builder', title: '🎲 짠 콘티', sets: sets.filter(st => st.songs.length) });
      } catch (e) { showToast('불러오기 실패: ' + e.message, 'error'); }
      return;
    case 'live':
      try {
        const songs = await cbSongs();
        closeModal(true);
        sendLive(nextSundayLabel(), songs.map(s => s.id));
      } catch (e) { showToast('실패: ' + e.message, 'error'); }
      return;
    case 'setlist':
      try {
        let added = 0;
        for (const s of await cbSongs()) if (!inSetlist(s.id)) { LibState.setlist.push(toSetlistItem(s)); added++; }
        afterSetlistChange();
        showToast(`${added}곡을 새 콘티에 담았어요.`, 'success');
      } catch (e) { showToast('실패: ' + e.message, 'error'); }
      return;
    case 'save': {
      const title = prompt('콘티 이름', nextSundayLabel());
      if (title === null) return;
      try {
        const songs = await cbSongs();
        const conti = await apiJson('/api/setlist/save', jsonBody('POST', {
          song_ids: songs.map(s => s.id), title: title.trim() || nextSundayLabel(), include_annotations: true,
        }));
        cbRecord(conti.title);
        showToast(`"${conti.title}"을 콘티 목록에 저장했어요 (${conti.page_count}쪽).`, 'success', 5000);
        closeModal(true);
        await refreshAll();
        openContiModal(conti.id);
      } catch (e) { showToast('저장 실패: ' + e.message, 'error'); }
      return;
    }
    default: return;
  }
  cbSave();
  renderContiBuilder();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-cb]');
  if (!el || el.disabled) return;
  if (el.dataset.cb === 'open') { openContiBuilder(); return; }
  if (LibState.modal?.type !== 'builder') return;
  cbAction(el.dataset.cb, el);
});

document.addEventListener('change', e => {
  const sel = e.target.closest('[data-cb-select]');
  if (!sel || LibState.modal?.type !== 'builder') return;
  Builder.slots[Number(sel.dataset.cbSelect)].id = Number(sel.value);
  cbSave();
  renderContiBuilder();
});
