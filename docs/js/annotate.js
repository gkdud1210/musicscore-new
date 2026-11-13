/**
 * PDF 위 필기(잉크) 오버레이
 * Pointer Events 기반 — Apple Pencil(pointerType 'pen')과 마우스는 항상 그리고,
 * 손가락 터치는 기본적으로 무시해서 스크롤/제스처를 방해하지 않는다.
 * 스트로크 좌표는 캔버스 폭/높이 대비 0~1 정규화 좌표로 저장 (줌/해상도 독립적).
 */

const AnnotateState = {
  tool: 'pen',        // 'pen' | 'highlighter' | 'eraser'
  color: '#ff3b30',
  widthRatio: 0.004,   // 캔버스 폭 대비 선 굵기 비율
  strokes: [],         // 현재 페이지의 스트로크 목록
  redo: [],            // ↪️ 다시 하기
  currentStroke: null,
  panMode: false,
  finger: true,        // ☝️ 손가락으로도 쓰기
  saveTimer: null,
  dirty: false,
};

// 펜·형광펜은 색·굵기를 따로 기억한다 (굵기 = 슬라이더 1~200, 선 굵기 = 값 / 2000 × 페이지 폭)
const INK_KEY = 'jandi.ink';
const INK_COLORS = {
  pen: [['#ff3b30', '빨강'], ['#111118', '검정'], ['#2f6fed', '파랑'], ['#22c55e', '초록'], ['#f59e0b', '주황'], ['#a855f7', '보라']],
  highlighter: [['#ffe600', '노랑'], ['#7cff4f', '연두'], ['#4fd8ff', '하늘'], ['#ff6ec7', '분홍'], ['#ff9f1a', '주황']],
};
const INK_DEFAULT = {
  pen: { color: '#ff3b30', width: 8 },
  highlighter: { color: '#ffe600', width: 24 },
  eraser: { width: 16 },
  finger: true,
};
const widthToRatio = v => Math.min(Math.max(Number(v) || 8, 1), 200) / 2000;
let INK = loadInkPrefs();

function loadInkPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(INK_KEY) || 'null');
    if (v && typeof v === 'object') return { ...INK_DEFAULT, ...v, pen: { ...INK_DEFAULT.pen, ...v.pen }, highlighter: { ...INK_DEFAULT.highlighter, ...v.highlighter }, eraser: { ...INK_DEFAULT.eraser, ...v.eraser } };
  } catch { /* 없음 */ }
  return JSON.parse(JSON.stringify(INK_DEFAULT));
}
function saveInkPrefs() {
  try { localStorage.setItem(INK_KEY, JSON.stringify(INK)); } catch { /* 저장 불가 */ }
}

function initAnnotationCanvas() {
  const canvas = document.getElementById('inkCanvas');
  canvas.style.touchAction = 'none';
  canvas.style.webkitTouchCallout = 'none';

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);

  document.querySelectorAll('.viewer-tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.getElementById('colorGroup').addEventListener('click', e => {
    const b = e.target.closest('.viewer-color-swatch');
    if (b) setColor(b.dataset.color);
  });
  document.getElementById('customColor').addEventListener('input', e => setColor(e.target.value));
  document.getElementById('widthRange').addEventListener('input', e => setWidth(e.target.value));
  document.getElementById('undoBtn').addEventListener('click', undoStroke);
  document.getElementById('redoBtn').addEventListener('click', redoStroke);
  document.getElementById('fingerBtn').addEventListener('click', () => setFinger(!AnnotateState.finger));
  document.getElementById('panModeBtn').addEventListener('click', togglePanMode);

  setFinger(INK.finger !== false, false);
  setTool('pen');

  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAnnotationSave(); });
  window.addEventListener('pagehide', () => flushAnnotationSave());
}

function setTool(tool) {
  AnnotateState.tool = tool;
  document.querySelectorAll('.viewer-tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  // 색 버튼: 펜/형광펜마다 다른 색 (지우개는 색 없음)
  const group = document.getElementById('colorGroup');
  group.classList.toggle('hidden-colors', tool === 'eraser');
  group.querySelectorAll('.viewer-color-swatch').forEach(b => b.remove());
  const custom = group.querySelector('.viewer-color-custom');
  (INK_COLORS[tool] || []).forEach(([c, name]) => custom.insertAdjacentHTML('beforebegin',
    `<button type="button" class="viewer-color-swatch" data-color="${c}" style="background:${c}" title="${name}" aria-label="${name}"></button>`));
  if (tool !== 'eraser') setColor(INK[tool].color, false);
  setWidth(INK[tool].width, false);
}

function setColor(color, remember = true) {
  if (AnnotateState.tool === 'eraser') return;
  AnnotateState.color = color;
  document.querySelectorAll('.viewer-color-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color.toLowerCase() === color.toLowerCase());
  });
  const custom = document.getElementById('customColor');
  if (custom && custom.value.toLowerCase() !== color.toLowerCase()) custom.value = color;
  custom?.parentElement.classList.toggle('active', ![...document.querySelectorAll('.viewer-color-swatch')].some(b => b.classList.contains('active')));
  if (remember) { INK[AnnotateState.tool].color = color; saveInkPrefs(); }
  updateWidthPreview();
}

function setWidth(v, remember = true) {
  v = Math.min(Math.max(Math.round(Number(v) || 8), 1), 200);
  AnnotateState.widthRatio = widthToRatio(v);
  const range = document.getElementById('widthRange');
  if (range && Number(range.value) !== v) range.value = v;
  document.getElementById('widthVal').textContent = v;
  if (remember) { INK[AnnotateState.tool].width = v; saveInkPrefs(); }
  updateWidthPreview();
}

/** 굵기 미리보기: 지금 화면 크기에서 실제 선 굵기 그대로 (너무 크면 칸에 맞춰) */
function updateWidthPreview() {
  const dot = document.querySelector('#widthPreview i');
  if (!dot) return;
  const canvas = document.getElementById('inkCanvas');
  const cssW = canvas?.getBoundingClientRect().width || 800;
  const px = Math.min(Math.max(AnnotateState.widthRatio * cssW, 2), 28);
  const t = AnnotateState.tool;
  dot.style.width = dot.style.height = px + 'px';
  dot.style.background = t === 'eraser' ? 'transparent' : AnnotateState.color;
  dot.style.border = t === 'eraser' ? '1px dashed currentColor' : '0';
  dot.style.opacity = t === 'highlighter' ? '0.45' : '1';
}

function setFinger(on, remember = true) {
  AnnotateState.finger = on;
  document.getElementById('fingerBtn')?.classList.toggle('active', on);
  if (remember) {
    INK.finger = on; saveInkPrefs();
    if (typeof showToast === 'function') showToast(on ? '☝️ 손가락으로도 써요. 화면을 움직이려면 🖐️ 을 누르세요.' : '✏️ 펜슬·마우스로만 써요. 손가락으로는 화면이 움직여요.', 'info', 2500);
  }
  if (!AnnotateState.panMode) {
    const canvas = document.getElementById('inkCanvas');
    // 손가락 쓰기를 끄면 손가락은 스크롤로 (펜슬은 그대로 그림)
    if (canvas) canvas.style.touchAction = on ? 'none' : 'pan-x pan-y pinch-zoom';
  }
}

function togglePanMode() {
  AnnotateState.panMode = !AnnotateState.panMode;
  const canvas = document.getElementById('inkCanvas');
  const btn = document.getElementById('panModeBtn');
  if (AnnotateState.panMode) {
    // 확대된 상태에서 손가락으로 화면을 이동할 수 있게, 잉크 캔버스가 터치를 가로채지 않게 함
    canvas.style.touchAction = 'pan-x pan-y';
    canvas.style.pointerEvents = 'none';
    btn.classList.add('active');
  } else {
    canvas.style.pointerEvents = 'auto';
    btn.classList.remove('active');
    setFinger(AnnotateState.finger, false);
  }
}

function getCanvasRelativePoint(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  return [x, y];
}

function shouldDraw(e) {
  if (AnnotateState.panMode) return false;
  if (e.pointerType === 'touch') return AnnotateState.finger && e.isPrimary;   // ☝️ 켜져 있을 때만, 한 손가락만
  return true;
}

function onPointerDown(e) {
  if (!shouldDraw(e)) return;
  e.preventDefault();
  const canvas = document.getElementById('inkCanvas');
  canvas.setPointerCapture(e.pointerId);

  const point = getCanvasRelativePoint(e, canvas);
  if (AnnotateState.currentStroke) return;   // 이미 그리는 중 (두 번째 손가락 등)
  AnnotateState.currentStroke = {
    tool: AnnotateState.tool,
    color: AnnotateState.tool === 'eraser' ? null : AnnotateState.color,
    width_ratio: AnnotateState.widthRatio,
    points: [point],
  };

  if (AnnotateState.tool === 'eraser') eraseAtPoint(point);
}

function onPointerMove(e) {
  if (!AnnotateState.currentStroke) return;
  const canvas = document.getElementById('inkCanvas');

  const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];

  if (AnnotateState.tool === 'eraser') {
    events.forEach(ev => eraseAtPoint(getCanvasRelativePoint(ev, canvas)));
  } else {
    events.forEach(ev => AnnotateState.currentStroke.points.push(getCanvasRelativePoint(ev, canvas)));
    redrawCanvas();
  }
}

function onPointerUp() {
  if (!AnnotateState.currentStroke) return;
  const pts = AnnotateState.currentStroke.points;
  if (pts.length === 1) pts.push([pts[0][0] + 0.0001, pts[0][1]]);   // 톡 찍으면 점
  if (AnnotateState.tool !== 'eraser' && pts.length >= 2) {
    AnnotateState.strokes.push(AnnotateState.currentStroke);
    AnnotateState.redo = [];
    scheduleAnnotationSave();
  }
  AnnotateState.currentStroke = null;
  redrawCanvas();
}

function eraseAtPoint(point) {
  const before = AnnotateState.strokes.length;
  // 지우개 크기 = 슬라이더 굵기 (작게 해도 너무 작지 않게)
  const tol = Math.max(AnnotateState.widthRatio * 1.5, 0.008);
  AnnotateState.strokes = AnnotateState.strokes.filter(stroke => !strokeHitsPoint(stroke, point, tol));
  if (AnnotateState.strokes.length !== before) {
    AnnotateState.redo = [];
    redrawCanvas();
    scheduleAnnotationSave();
  }
}

function strokeHitsPoint(stroke, point, tol) {
  const pts = stroke.points;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distToSegment(point, pts[i], pts[i + 1]) < tol + (stroke.width_ratio || 0) / 2) return true;
  }
  return pts.length === 1 && Math.hypot(point[0] - pts[0][0], point[1] - pts[0][1]) < tol + (stroke.width_ratio || 0) / 2;
}

function distToSegment(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function undoStroke() {
  if (AnnotateState.strokes.length === 0) return;
  AnnotateState.redo.push(AnnotateState.strokes.pop());
  redrawCanvas();
  scheduleAnnotationSave();
}

function redoStroke() {
  if (!AnnotateState.redo.length) return;
  AnnotateState.strokes.push(AnnotateState.redo.pop());
  redrawCanvas();
  scheduleAnnotationSave();
}

function redrawCanvas() {
  const canvas = document.getElementById('inkCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const strokes = (AnnotateState.currentStroke && AnnotateState.tool !== 'eraser')
    ? [...AnnotateState.strokes, AnnotateState.currentStroke]
    : AnnotateState.strokes;

  // 형광펜을 먼저(아래), 펜을 나중에(위) 그려서 펜 글씨가 형광펜에 묻히지 않게
  strokes.filter(st => st.tool === 'highlighter').forEach(stroke => drawStroke(ctx, canvas, stroke));
  strokes.filter(st => st.tool !== 'highlighter').forEach(stroke => drawStroke(ctx, canvas, stroke));
}

function drawStroke(ctx, canvas, stroke) {
  if (!Array.isArray(stroke?.points) || stroke.points.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = stroke.color || '#ff3b30';
  ctx.globalAlpha = stroke.tool === 'highlighter' ? 0.35 : 1.0;
  ctx.lineWidth = Math.max(stroke.width_ratio * canvas.width, 1);
  ctx.beginPath();
  const [x0, y0] = stroke.points[0];
  ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
  for (let i = 1; i < stroke.points.length; i++) {
    const [x, y] = stroke.points[i];
    ctx.lineTo(x * canvas.width, y * canvas.height);
  }
  ctx.stroke();
  ctx.restore();
}

function resizeInkCanvas(widthPx, heightPx) {
  const canvas = document.getElementById('inkCanvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  canvas.style.width = widthPx + 'px';
  canvas.style.height = heightPx + 'px';
}

async function loadAnnotationsForCurrentPage() {
  try {
    const res = await fetch(`${API_BASE}/api/scores/${ViewerState.scoreId}/annotations/${ViewerState.currentPage}`);
    const data = await res.json();
    AnnotateState.strokes = data.strokes || [];
  } catch (e) {
    console.warn('필기 불러오기 실패:', e);
    AnnotateState.strokes = [];
  }
  AnnotateState.currentStroke = null;
  AnnotateState.redo = [];
  AnnotateState.dirty = false;
  redrawCanvas();
  updateWidthPreview();
}

function scheduleAnnotationSave() {
  AnnotateState.dirty = true;
  clearTimeout(AnnotateState.saveTimer);
  AnnotateState.saveTimer = setTimeout(saveAnnotations, 800);
}

async function saveAnnotations() {
  if (!AnnotateState.dirty) return;
  const scoreId = ViewerState.scoreId;
  const page = ViewerState.currentPage;
  const strokes = AnnotateState.strokes;
  AnnotateState.dirty = false;
  try {
    await fetch(`${API_BASE}/api/scores/${scoreId}/annotations/${page}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strokes }),
    });
  } catch (e) {
    console.warn('필기 저장 실패:', e);
    AnnotateState.dirty = true; // 다음 트리거 때 재시도되도록 유지
  }
}

async function flushAnnotationSave() {
  clearTimeout(AnnotateState.saveTimer);
  if (AnnotateState.dirty) await saveAnnotations();
}
