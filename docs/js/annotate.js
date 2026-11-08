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
  currentStroke: null,
  panMode: false,
  saveTimer: null,
  dirty: false,
};

const WIDTH_PRESETS = { thin: 0.0025, medium: 0.004, thick: 0.008 };
const ERASE_TOLERANCE = 0.02; // 정규화 좌표 기준 지우개 히트 테스트 허용 범위

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
  document.querySelectorAll('.viewer-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => setColor(btn.dataset.color));
  });
  document.querySelectorAll('.viewer-width-btn').forEach(btn => {
    btn.addEventListener('click', () => setWidth(btn.dataset.width));
  });
  document.getElementById('undoBtn').addEventListener('click', undoStroke);
  document.getElementById('panModeBtn').addEventListener('click', togglePanMode);

  setTool('pen');
  setWidth('medium');

  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAnnotationSave(); });
  window.addEventListener('pagehide', () => flushAnnotationSave());
}

function setTool(tool) {
  AnnotateState.tool = tool;
  document.querySelectorAll('.viewer-tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

function setColor(color) {
  AnnotateState.color = color;
  document.querySelectorAll('.viewer-color-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

function setWidth(key) {
  AnnotateState.widthRatio = WIDTH_PRESETS[key] || WIDTH_PRESETS.medium;
  document.querySelectorAll('.viewer-width-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.width === key);
  });
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
    canvas.style.touchAction = 'none';
    canvas.style.pointerEvents = 'auto';
    btn.classList.remove('active');
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
  if (e.pointerType === 'touch') return false; // 손가락은 기본적으로 그리지 않음
  return true;
}

function onPointerDown(e) {
  if (!shouldDraw(e)) return;
  e.preventDefault();
  const canvas = document.getElementById('inkCanvas');
  canvas.setPointerCapture(e.pointerId);

  const point = getCanvasRelativePoint(e, canvas);
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
  if (AnnotateState.tool !== 'eraser' && AnnotateState.currentStroke.points.length >= 2) {
    AnnotateState.strokes.push(AnnotateState.currentStroke);
    scheduleAnnotationSave();
  }
  AnnotateState.currentStroke = null;
  redrawCanvas();
}

function eraseAtPoint(point) {
  const before = AnnotateState.strokes.length;
  AnnotateState.strokes = AnnotateState.strokes.filter(stroke => !strokeHitsPoint(stroke, point));
  if (AnnotateState.strokes.length !== before) {
    redrawCanvas();
    scheduleAnnotationSave();
  }
}

function strokeHitsPoint(stroke, point) {
  const pts = stroke.points;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distToSegment(point, pts[i], pts[i + 1]) < ERASE_TOLERANCE) return true;
  }
  return pts.length === 1 && Math.hypot(point[0] - pts[0][0], point[1] - pts[0][1]) < ERASE_TOLERANCE;
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
  AnnotateState.strokes.pop();
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

  strokes.forEach(stroke => drawStroke(ctx, canvas, stroke));
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
  AnnotateState.dirty = false;
  redrawCanvas();
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
