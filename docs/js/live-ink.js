/**
 * ✍️ 라이브 필기 — 라이브 화면의 악보 위에 펜·형광펜·지우개로 쓰기.
 * - 악보 화면의 ✍️ 필기와 같은 곳(/api/scores/{id}/annotations/{쪽})에 저장 → 팀 모두의 같은 악보에 남고,
 *   ✍️ 필기 화면·PDF 내보내기에도 그대로 나온다. 이미 해둔 필기는 라이브에서도 늘 보인다.
 * - 다른 사람이 쓴 필기는 그 쪽을 다시 열거나 화면이 새로 그려질 때 보인다 (실시간 아님).
 * - 붙여넣은 사진(콘티에 없는 그림)에는 쓸 수 없다.
 * 좌표는 annotate.js 와 같은 형식: 그림 폭/높이 대비 0~1, 굵기는 폭 대비 비율.
 */
const LiveInk = {
  on: false,
  tool: 'pen',            // pen | highlighter | eraser
  color: { pen: '#ff3b30', highlighter: '#ffe600' },
  width: { pen: 8, highlighter: 40, eraser: 20 },   // 1~200 (annotate.js 와 같은 눈금: 값 / 2000 × 쪽 폭). 형광펜은 아주 굵게도
  cache: new Map(),       // 'scoreId/page' → { strokes, at, redo }
  saveTimers: new Map(),
  drawing: null,          // { key, canvas, stroke }
};
const LIVE_INK_KEY = 'jandi.live.ink';
const LIVE_INK_COLORS = {
  pen: [['#ff3b30', '빨강'], ['#111118', '검정'], ['#2f6fed', '파랑'], ['#22c55e', '초록']],
  highlighter: [['#ffe600', '노랑'], ['#7cff4f', '연두'], ['#4fd8ff', '하늘'], ['#ff6ec7', '분홍']],
};
const LIVE_INK_MAX = 200;

(function loadLiveInkPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(LIVE_INK_KEY) || 'null');
    if (v?.color) Object.assign(LiveInk.color, v.color);
    if (v?.width) Object.assign(LiveInk.width, v.width);
    if (v?.tool) LiveInk.tool = v.tool;
  } catch { /* 없음 */ }
})();
function saveLiveInkPrefs() {
  try { localStorage.setItem(LIVE_INK_KEY, JSON.stringify({ tool: LiveInk.tool, color: LiveInk.color, width: LiveInk.width })); } catch { /* 저장 불가 */ }
}

/** 그림 주소 → 필기 자리 ('콘티id/쪽'). 콘티 악보가 아니면 null */
function liveInkKey(url) {
  const m = /\/api\/scores\/(\d+)\/pages\/(\d+)\/image/.exec(url || '');
  return m ? `${m[1]}/${m[2]}` : null;
}

/** renderLiveSet 뒤에 불린다: 쪽마다 필기 캔버스를 그림 위에 얹고, 필기를 불러와 그린다 */
function liveInkAttach() {
  const track = document.getElementById('liveTrack');
  if (!track) return;
  document.getElementById('liveViewer')?.classList.toggle('inking', LiveInk.on);
  renderLiveInkBar();
  const slides = LiveState.slides || [];
  track.querySelectorAll('.live-slide').forEach((slide, i) => {
    const key = liveInkKey(slides[i]?.url);
    if (!key) return;
    const img = slide.querySelector('img');
    const canvas = document.createElement('canvas');
    canvas.className = 'live-ink';
    canvas.dataset.key = key;
    slide.appendChild(canvas);
    canvas.addEventListener('pointerdown', liveInkDown);
    canvas.addEventListener('pointermove', liveInkMove);
    canvas.addEventListener('pointerup', liveInkUp);
    canvas.addEventListener('pointercancel', liveInkUp);
    const ready = () => { placeLiveInk(canvas, img); loadLiveInk(key).then(() => drawLiveInk(canvas)); };
    if (img.complete && img.naturalWidth) ready(); else img.addEventListener('load', ready, { once: true });
  });
}

/** 캔버스를 그림이 실제로 보이는 자리·크기에 맞춘다 */
function placeLiveInk(canvas, img) {
  const w = img.offsetWidth, h = img.offsetHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.left = img.offsetLeft + 'px';
  canvas.style.top = img.offsetTop + 'px';
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function relayoutLiveInk() {
  document.querySelectorAll('#liveTrack canvas.live-ink').forEach(c => {
    const img = c.parentElement.querySelector('img');
    if (img) { placeLiveInk(c, img); drawLiveInk(c); }
  });
}
window.addEventListener('resize', () => { clearTimeout(LiveInk.rt); LiveInk.rt = setTimeout(relayoutLiveInk, 150); });

async function loadLiveInk(key, force = false) {
  const c = LiveInk.cache.get(key);
  if (c && (!force && Date.now() - c.at < 15000 || LiveInk.saveTimers.has(key))) return c;
  try {
    const { strokes } = await apiJson(`/api/scores/${key.replace('/', '/annotations/')}`);
    const next = { strokes: Array.isArray(strokes) ? strokes : [], at: Date.now(), redo: c?.redo || [] };
    if (!LiveInk.saveTimers.has(key)) LiveInk.cache.set(key, next);   // 쓰는 중이면 내 것을 지킨다
  } catch {
    if (!c) LiveInk.cache.set(key, { strokes: [], at: Date.now(), redo: [] });
  }
  return LiveInk.cache.get(key);
}

function drawLiveInk(canvas, extra = null) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = [...(LiveInk.cache.get(canvas.dataset.key)?.strokes || []), ...(extra ? [extra] : [])];
  // 형광펜 아래, 펜 위
  [...strokes.filter(s => s.tool === 'highlighter'), ...strokes.filter(s => s.tool !== 'highlighter')].forEach(st => {
    if (!Array.isArray(st?.points) || st.points.length < 2) return;
    ctx.save();
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.strokeStyle = st.color || '#ff3b30';
    ctx.globalAlpha = st.tool === 'highlighter' ? 0.35 : 1;
    ctx.lineWidth = Math.max((st.width_ratio || 0.004) * canvas.width, 1);
    ctx.beginPath();
    st.points.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x * canvas.width, y * canvas.height));
    ctx.stroke();
    ctx.restore();
  });
}

const liveInkPoint = (e, canvas) => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
};
const liveInkRatio = () => Math.min(Math.max(LiveInk.width[LiveInk.tool] || 8, 1), LIVE_INK_MAX) / 2000;

function liveInkDown(e) {
  if (!LiveInk.on || LiveInk.drawing || (e.pointerType === 'touch' && !e.isPrimary)) return;
  e.preventDefault();
  const canvas = e.currentTarget;
  canvas.setPointerCapture?.(e.pointerId);
  const p = liveInkPoint(e, canvas);
  LiveInk.drawing = {
    key: canvas.dataset.key, canvas,
    stroke: { tool: LiveInk.tool, color: LiveInk.tool === 'eraser' ? null : LiveInk.color[LiveInk.tool], width_ratio: liveInkRatio(), points: [p] },
  };
  if (LiveInk.tool === 'eraser') liveInkErase(p);
}

function liveInkMove(e) {
  const d = LiveInk.drawing;
  if (!d || d.canvas !== e.currentTarget) return;
  e.preventDefault();
  const co = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  const evs = co.length ? co : [e];
  if (LiveInk.tool === 'eraser') { evs.forEach(ev => liveInkErase(liveInkPoint(ev, d.canvas))); return; }
  evs.forEach(ev => d.stroke.points.push(liveInkPoint(ev, d.canvas)));
  drawLiveInk(d.canvas, d.stroke);
}

function liveInkUp() {
  const d = LiveInk.drawing;
  if (!d) return;
  LiveInk.drawing = null;
  if (d.stroke.tool === 'eraser') return;
  const pts = d.stroke.points;
  if (pts.length === 1) pts.push([pts[0][0] + 0.0001, pts[0][1]]);   // 톡 찍으면 점
  const c = LiveInk.cache.get(d.key) || { strokes: [], at: Date.now(), redo: [] };
  c.strokes.push(d.stroke);
  c.redo = [];
  LiveInk.cache.set(d.key, c);
  LiveInk.last = d.key;
  drawLiveInk(d.canvas);
  saveLiveInkSoon(d.key);
}

function liveInkErase(p) {
  const d = LiveInk.drawing;
  const c = LiveInk.cache.get(d.key);
  if (!c) return;
  const tol = Math.max(liveInkRatio() * 1.5, 0.008);
  const hit = st => st.points.some((pt, i) => {
    const q = st.points[i + 1] || pt;
    const dx = q[0] - pt[0], dy = q[1] - pt[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p[0] - pt[0]) * dx + (p[1] - pt[1]) * dy) / len)) : 0;
    return Math.hypot(p[0] - (pt[0] + t * dx), p[1] - (pt[1] + t * dy)) < tol + (st.width_ratio || 0) / 2;
  });
  const before = c.strokes.length;
  const removed = c.strokes.filter(hit);
  if (!removed.length) return;
  c.strokes = c.strokes.filter(st => !removed.includes(st));
  if (c.strokes.length !== before) { c.redo = []; LiveInk.last = d.key; drawLiveInk(d.canvas); saveLiveInkSoon(d.key); }
}

function saveLiveInkSoon(key) {
  clearTimeout(LiveInk.saveTimers.get(key));
  LiveInk.saveTimers.set(key, setTimeout(() => saveLiveInk(key), 700));
}

async function saveLiveInk(key) {
  LiveInk.saveTimers.delete(key);
  const c = LiveInk.cache.get(key);
  if (!c) return;
  try {
    await apiJson(`/api/scores/${key.replace('/', '/annotations/')}`, jsonBody('PUT', { strokes: c.strokes }));
    c.at = Date.now();
  } catch (e) {
    showToast('필기 저장 실패: ' + e.message, 'error');
  }
}

function flushLiveInk() {
  [...LiveInk.saveTimers.keys()].forEach(k => { clearTimeout(LiveInk.saveTimers.get(k)); saveLiveInk(k); });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushLiveInk(); });
window.addEventListener('pagehide', flushLiveInk);

/** 지금 보고 있는 쪽의 필기 자리 */
function curLiveInkKey() {
  return liveInkKey((LiveState.slides || [])[liveIndex()]?.url);
}

function liveInkUndo(redo = false) {
  const key = curLiveInkKey();
  const c = key && LiveInk.cache.get(key);
  if (!c) return;
  const [from, to] = redo ? [c.redo, c.strokes] : [c.strokes, c.redo];
  if (!from.length) return;
  to.push(from.pop());
  document.querySelectorAll(`#liveTrack canvas.live-ink[data-key="${key}"]`).forEach(cv => drawLiveInk(cv));
  saveLiveInkSoon(key);
}

function toggleLiveInk(on = !LiveInk.on) {
  if (on && !curLiveInkKey()) {
    const any = (LiveState.slides || []).some(sl => liveInkKey(sl.url));
    if (!any) { showToast('붙여넣은 사진에는 필기할 수 없어요. 🎼 새 콘티에 담은 뒤 써주세요.', 'info', 4000); return; }
  }
  LiveInk.on = on;
  if (!on) flushLiveInk();
  document.getElementById('liveViewer')?.classList.toggle('inking', on);
  document.querySelector('[data-live="ink"]')?.classList.toggle('active', on);
  renderLiveInkBar();
  if (on) showToast('✍️ 악보 위에 써요. 넘기기는 ‹ › 버튼으로. 쓴 건 팀 모두의 같은 악보에 남아요.', 'info', 3500);
}

function renderLiveInkBar() {
  const v = document.getElementById('liveViewer');
  if (!v) return;
  let bar = document.getElementById('liveInkBar');
  if (!LiveInk.on) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'liveInkBar';
    bar.className = 'live-ink-bar';
    v.appendChild(bar);
  }
  const t = LiveInk.tool;
  const tool = (k, label) => `<button type="button" class="live-ink-btn${t === k ? ' on' : ''}" data-live="ink-tool" data-tool="${k}">${label}</button>`;
  const colors = (LIVE_INK_COLORS[t] || []).map(([c, name]) =>
    `<button type="button" class="live-ink-color${LiveInk.color[t] === c ? ' on' : ''}" data-live="ink-color" data-color="${c}" style="background:${c}" title="${name}" aria-label="${name}"></button>`).join('');
  const w = LiveInk.width[t];
  const widths = `<label class="live-ink-width" title="굵기 (1~${LIVE_INK_MAX})">
      <input type="range" id="liveInkWidth" min="1" max="${LIVE_INK_MAX}" step="1" value="${w}" aria-label="굵기" />
      <span class="live-ink-prev" id="liveInkPrev"><i></i></span><b id="liveInkWval">${w}</b></label>`;
  bar.innerHTML = `${tool('pen', '🖊️')}${tool('highlighter', '🖍️')}${tool('eraser', '🧽')}
    <span class="live-ink-sep"></span>${t === 'eraser' ? '' : colors}${t === 'eraser' ? '' : '<span class="live-ink-sep"></span>'}${widths}
    <span class="live-ink-sep"></span>
    <button type="button" class="live-ink-btn" data-live="ink-undo" title="되돌리기" aria-label="되돌리기">↩️</button>
    <button type="button" class="live-ink-btn" data-live="ink-redo" title="다시 하기" aria-label="다시 하기">↪️</button>
    <button type="button" class="live-ink-btn done" data-live="ink">완료</button>`;
  const range = bar.querySelector('#liveInkWidth');
  range.addEventListener('input', () => {
    LiveInk.width[LiveInk.tool] = Number(range.value);
    bar.querySelector('#liveInkWval').textContent = range.value;
    updateLiveInkPreview();
  });
  range.addEventListener('change', saveLiveInkPrefs);
  updateLiveInkPreview();
}

/** 굵기 미리보기: 지금 보는 악보에서 실제로 그려질 굵기 그대로 (칸보다 크면 칸에 맞춰) */
function updateLiveInkPreview() {
  const dot = document.querySelector('#liveInkPrev i');
  if (!dot) return;
  const t = LiveInk.tool;
  const cv = document.querySelector(`#liveTrack canvas.live-ink[data-key="${curLiveInkKey()}"]`) || document.querySelector('#liveTrack canvas.live-ink');
  const cssW = cv?.getBoundingClientRect().width || 600;
  const px = Math.min(Math.max(liveInkRatio() * cssW, 2), 30);
  Object.assign(dot.style, {
    width: px + 'px', height: (t === 'highlighter' ? Math.max(px * 0.6, 2) : px) + 'px',
    borderRadius: t === 'highlighter' ? '3px' : '50%',
    background: t === 'eraser' ? 'transparent' : LiveInk.color[t],
    border: t === 'eraser' ? '1px dashed currentColor' : '0',
    opacity: t === 'highlighter' ? '0.5' : '1',
  });
}

/** live.js 의 버튼 처리에서 넘겨받는다. 처리했으면 true */
function liveInkAction(act, el) {
  switch (act) {
    case 'ink': toggleLiveInk(); return true;
    case 'ink-tool': LiveInk.tool = el.dataset.tool; break;
    case 'ink-color': LiveInk.color[LiveInk.tool] = el.dataset.color; break;
    case 'ink-undo': liveInkUndo(); return true;
    case 'ink-redo': liveInkUndo(true); return true;
    default: return false;
  }
  saveLiveInkPrefs();
  renderLiveInkBar();
  return true;
}
