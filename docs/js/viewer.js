/**
 * 악보 뷰어 — PDF.js 페이지 렌더 + 페이지 이동 + 확대/축소 + 내보내기 + 조 변환 연동
 * ScoreShift
 */

const ViewerState = {
  scoreId: null,
  title: '',
  pdfDoc: null,
  currentPage: 1,
  pageCount: 1,
  scale: 1,
  baseScaleComputed: false,
  rendering: false,
};

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

window.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get('id'));
  if (!id) {
    showToast('잘못된 접근입니다. 라이브러리로 이동합니다.', 'error');
    setTimeout(() => { window.location.href = 'index.html'; }, 1200);
    return;
  }
  ViewerState.scoreId = id;

  try {
    await loadScoreMeta();
    const startPage = Number(params.get('page'));
    if (startPage >= 1 && startPage <= ViewerState.pageCount) ViewerState.currentPage = startPage;
    await loadPdf();
    initAnnotationCanvas();
    initToolbar();
    await renderCurrentPage();
  } catch (e) {
    console.error(e);
    showToast('악보를 불러오지 못했습니다: ' + e.message, 'error');
  }
});

async function loadScoreMeta() {
  const res = await fetch(`${API_BASE}/api/scores/${ViewerState.scoreId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  ViewerState.title = data.title;
  ViewerState.pageCount = data.page_count;
  document.getElementById('viewerTitle').textContent = data.title;
}

async function loadPdf() {
  const loadingTask = pdfjsLib.getDocument(`${API_BASE}/api/scores/${ViewerState.scoreId}/file`);
  ViewerState.pdfDoc = await loadingTask.promise;
}

async function renderCurrentPage() {
  if (ViewerState.rendering) return;
  ViewerState.rendering = true;
  try {
    const page = await ViewerState.pdfDoc.getPage(ViewerState.currentPage);
    const unscaledViewport = page.getViewport({ scale: 1 });

    if (!ViewerState.baseScaleComputed) {
      const scrollEl = document.getElementById('canvasScroll');
      const containerWidth = (scrollEl.clientWidth || 800) - 24;
      ViewerState.scale = Math.max(containerWidth / unscaledViewport.width, 0.2);
      ViewerState.baseScaleComputed = true;
    }

    const viewport = page.getViewport({ scale: ViewerState.scale });

    const pdfCanvas = document.getElementById('pdfCanvas');
    const ctx = pdfCanvas.getContext('2d');
    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;
    pdfCanvas.style.width = viewport.width + 'px';
    pdfCanvas.style.height = viewport.height + 'px';

    await page.render({ canvasContext: ctx, viewport }).promise;

    resizeInkCanvas(viewport.width, viewport.height);
    await loadAnnotationsForCurrentPage();

    updatePageIndicator();
  } finally {
    ViewerState.rendering = false;
  }
}

function updatePageIndicator() {
  document.getElementById('pageIndicator').textContent = `${ViewerState.currentPage} / ${ViewerState.pageCount}`;
  document.getElementById('prevPageBtn').disabled = ViewerState.currentPage <= 1;
  document.getElementById('nextPageBtn').disabled = ViewerState.currentPage >= ViewerState.pageCount;
}

async function goToPage(delta) {
  await flushAnnotationSave();
  const next = ViewerState.currentPage + delta;
  if (next < 1 || next > ViewerState.pageCount) return;
  ViewerState.currentPage = next;
  await renderCurrentPage();
}

async function zoomBy(factor) {
  await flushAnnotationSave();
  ViewerState.scale = Math.min(Math.max(ViewerState.scale * factor, 0.3), 4);
  await renderCurrentPage();
}

function initToolbar() {
  document.getElementById('prevPageBtn').addEventListener('click', () => goToPage(-1));
  document.getElementById('nextPageBtn').addEventListener('click', () => goToPage(1));
  document.getElementById('zoomInBtn').addEventListener('click', () => zoomBy(1.25));
  document.getElementById('zoomOutBtn').addEventListener('click', () => zoomBy(1 / 1.25));
  document.getElementById('exportBtn').addEventListener('click', exportAnnotatedPdf);
  document.getElementById('analyzePageBtn').addEventListener('click', analyzeCurrentPage);
}

async function exportAnnotatedPdf() {
  await flushAnnotationSave();
  showToast('필기를 반영한 PDF를 준비하는 중...', 'info');
  try {
    const res = await fetch(`${API_BASE}/api/scores/${ViewerState.scoreId}/export`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ViewerState.title || 'score'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('다운로드를 시작했습니다.', 'success');
  } catch (e) {
    console.error(e);
    showToast('내보내기 실패: ' + e.message, 'error');
  }
}

async function analyzeCurrentPage() {
  showToast('이 페이지를 분석하는 중...', 'info');
  try {
    const res = await fetch(
      `${API_BASE}/api/scores/${ViewerState.scoreId}/analyze-page/${ViewerState.currentPage}`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sessionStorage.setItem('prefillAnalysis', JSON.stringify(data));
    window.location.href = 'transpose.html';
  } catch (e) {
    console.error(e);
    showToast('분석 실패: ' + e.message, 'error');
  }
}
