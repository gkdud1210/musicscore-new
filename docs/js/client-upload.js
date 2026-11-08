/**
 * 카페24(PHP) 서버용: PDF를 브라우저에서 페이지 그림으로 바꿔 올리고, 페이지마다 서버에 "읽어줘"를 요청한다.
 * (카페24는 프로그램 설치가 안 되고 오래 걸리는 요청이 끊기므로, 무거운 일은 브라우저가 나눠서 부른다)
 *
 * 순서: 콘티 만들기 → 페이지 그림 올리기(전부) → 페이지마다 읽기(3장씩 동시에) → 곡 나누기(finish)
 * 맥(파이썬) 서버에서는 쓰지 않는다 — AuthState.server === 'php' 일 때만.
 */

const PDFJS_VERSION = '3.11.174';
const PAGE_IMAGE_WIDTH = 1400;   // 화면에 보여줄 페이지 그림 폭(px) — 맥 버전과 같음
const THUMB_WIDTH = 300;
const READ_PARALLEL = 3;

const isPhpServer = () => AuthState.server === 'php';

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('PDF 프로그램(PDF.js)을 불러오지 못했어요. 인터넷을 확인해주세요'));
    document.head.appendChild(s);
  });
}

async function getPdfJs() {
  if (!window.pdfjsLib) {
    await loadScriptOnce(`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`);
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
  return pdfjsLib;
}

async function sha256Hex(buf) {
  if (!crypto?.subtle) return '';
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** PDF 페이지 → JPEG Blob (흰 바탕) */
async function renderPageJpeg(page, targetWidth, quality = 0.85) {
  const base = page.getViewport({ scale: 1 });
  let scale = targetWidth / base.width;
  if (base.height * scale > 4000) scale = 4000 / base.height;   // 아주 긴 페이지는 높이 기준으로
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  canvas.width = canvas.height = 0;   // 메모리 바로 비우기 (아이패드)
  if (!blob) throw new Error('페이지 그림을 만들지 못했어요');
  return { blob, width: base.width, height: base.height };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 요청 하나: 한도 초과(429)·잠깐 끊김(5xx·네트워크)은 기다렸다 다시 */
async function postWithRetry(path, options, label) {
  const waits = [5, 10, 20, 40, 60, 60];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, options);
    } catch (e) {
      if (attempt >= waits.length) throw new Error(`${label}: 인터넷 연결이 끊겼어요`);
      await sleep(waits[attempt] * 1000);
      continue;
    }
    if (res.ok) return res.json();
    const err = await res.json().catch(() => ({}));
    const retry = res.status === 429 || res.status >= 500;
    if (!retry || attempt >= waits.length) throw new Error(err.detail || `${label}: HTTP ${res.status}`);
    // 제미나이가 "몇 초 뒤에"를 알려주면 그만큼만 기다린다
    const hint = Number(res.headers.get('Retry-After')) || 0;
    await sleep((hint ? Math.min(60, Math.max(3, hint)) : waits[attempt]) * 1000);
  }
}

/** n개 일을 최대 limit개씩 동시에 */
async function runLimited(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function readAllPages(contiId, pageCount, reuse, onProgress) {
  let done = 0;
  let reused = 0;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  onProgress?.(`읽는 중 0/${pageCount}쪽`);
  await runLimited(pages, READ_PARALLEL, async n => {
    const r = await postWithRetry(`/api/scores/${contiId}/pages/${n}/read`, jsonBody('POST', { reuse }), `${n}쪽 읽기`);
    done++;
    if (r.reused) reused++;
    onProgress?.(`읽는 중 ${done}/${pageCount}쪽${reused ? ` (전에 읽은 악보 ${reused}쪽)` : ''}`);
  });
}

async function markFailed(contiId, message) {
  try {
    await fetch(`${API_BASE}/api/scores/${contiId}/fail`, jsonBody('POST', { detail: message }));
  } catch { /* 서버에 못 알려도 15분 뒤에 '멈춤'으로 보인다 */ }
}

/** 콘티 PDF 하나 올리기 → 맥 버전 업로드와 같은 결과(conti 요약)를 돌려준다 */
async function clientUploadPdf(file, onProgress) {
  const pdfjs = await getPdfJs();
  onProgress?.('PDF 여는 중');
  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(buf);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pageCount = pdf.numPages;
  // 맥 파일 이름의 풀어쓴 한글(NFD)은 검색에 안 걸리므로 붙은 형태(NFC)로
  let conti = await apiJson('/api/scores', jsonBody('POST', { filename: file.name.normalize('NFC'), page_count: pageCount, file_hash: hash }));
  if (conti.duplicate) { pdf.destroy(); return conti; }

  try {
    for (let n = 1; n <= pageCount; n++) {
      onProgress?.(`올리는 중 ${n}/${pageCount}쪽`);
      const page = await pdf.getPage(n);
      const img = await renderPageJpeg(page, PAGE_IMAGE_WIDTH);
      const fd = new FormData();
      fd.append('image', img.blob, `p${n}.jpg`);
      fd.append('width', String(img.width));
      fd.append('height', String(img.height));
      if (n === 1) fd.append('thumb', (await renderPageJpeg(page, THUMB_WIDTH, 0.8)).blob, 'thumb.jpg');
      page.cleanup();
      await postWithRetry(`/api/scores/${conti.id}/pages/${n}`, { method: 'POST', body: fd }, `${n}쪽 올리기`);
    }
    pdf.destroy();
    await readAllPages(conti.id, pageCount, true, onProgress);
    onProgress?.('곡 나누는 중');
    conti = await postWithRetry(`/api/scores/${conti.id}/finish`, jsonBody('POST', { first_upload: true }), '곡 나누기');
    return conti;
  } catch (e) {
    await markFailed(conti.id, e.message);
    throw e;
  }
}

/* ============================================================
   사진(JPG·PNG·아이폰 사진)으로 올리기 — 한 번에 고른 사진들 = 콘티 하나 (사진 한 장 = 한 쪽)
   AI가 제목·키를 읽어 곡으로 나누고, 못 읽은 사진은 '제목 없음' 곡으로 남겨 직접 적게 한다
   ============================================================ */
const isImageFile = f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(f.name);

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });   // 사진 회전 정보 반영
  } catch { /* 옛 브라우저 → 아래 방법 */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    const heic = /\.(heic|heif)$/i.test(file.name);
    throw new Error(`"${file.name}" 사진을 열 수 없어요${heic ? ' (HEIC 형식 — 아이폰에서 바로 올리거나 JPG로 바꿔 올려주세요)' : ''}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 사진 → JPEG Blob (흰 바탕, 작은 사진은 키우지 않음) */
async function imageToJpeg(src, targetWidth, quality = 0.85) {
  const w = src.width, h = src.height;
  let scale = Math.min(1, targetWidth / w);
  if (h * scale > 4000) scale = 4000 / h;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('사진을 바꾸지 못했어요');
  return blob;
}

async function clientUploadImages(files, label, onProgress) {
  const pageCount = files.length;
  onProgress?.('사진 여는 중');
  const hashes = [];
  for (const f of files) hashes.push(await sha256Hex(await f.arrayBuffer()));
  const hash = hashes.every(Boolean) ? await sha256Hex(new TextEncoder().encode(hashes.join(','))) : '';
  let conti = await apiJson('/api/scores', jsonBody('POST', { filename: label, page_count: pageCount, file_hash: hash }));
  if (conti.duplicate) return conti;

  try {
    for (let n = 1; n <= pageCount; n++) {
      onProgress?.(`올리는 중 ${n}/${pageCount}장`);
      const src = await decodeImage(files[n - 1]);
      const fd = new FormData();
      fd.append('image', await imageToJpeg(src, PAGE_IMAGE_WIDTH), `p${n}.jpg`);
      // 쪽 크기는 PDF처럼 폭 595 기준으로 (필기·내보내기가 같은 비율을 쓰게)
      fd.append('width', '595');
      fd.append('height', String(Math.round(595 * src.height / src.width)));
      if (n === 1) fd.append('thumb', await imageToJpeg(src, THUMB_WIDTH, 0.8), 'thumb.jpg');
      src.close?.();
      await postWithRetry(`/api/scores/${conti.id}/pages/${n}`, { method: 'POST', body: fd }, `${n}번째 사진 올리기`);
    }
    // AI 읽기: 실패한 장이 있어도 멈추지 않는다
    let unread = 0, done = 0;
    const nums = Array.from({ length: pageCount }, (_, i) => i + 1);
    onProgress?.(`AI가 읽는 중 0/${pageCount}장`);
    await runLimited(nums, READ_PARALLEL, async n => {
      try {
        await postWithRetry(`/api/scores/${conti.id}/pages/${n}/read`, jsonBody('POST', { reuse: true }), `${n}번째 사진 읽기`);
      } catch (e) {
        console.warn(e);
        unread++;
      }
      onProgress?.(`AI가 읽는 중 ${++done}/${pageCount}장`);
    });
    onProgress?.('곡 나누는 중');
    conti = await postWithRetry(`/api/scores/${conti.id}/finish`, jsonBody('POST', { first_upload: true, allow_unread: true }), '곡 나누기');
    conti.unread = unread;
    return conti;
  } catch (e) {
    await markFailed(conti.id, e.message);
    throw e;
  }
}

/** "처음부터 다시 분석": 저장된 페이지 그림을 제미나이로 다시 읽는다 (브라우저가 열려 있는 동안 진행) */
const ReprocessJobs = new Set();

async function clientReprocess(contiId) {
  if (ReprocessJobs.has(contiId)) throw new Error('이미 다시 읽는 중이에요');
  const conti = await apiJson(`/api/scores/${contiId}/reprocess`, { method: 'POST' });
  ReprocessJobs.add(contiId);
  // 화면은 기다리지 않고 바로 돌려준다 — 콘티 화면이 "분석 중"을 보여주며 몇 초마다 확인한다
  (async () => {
    try {
      await readAllPages(contiId, conti.page_count, false);
      await postWithRetry(`/api/scores/${contiId}/finish`, jsonBody('POST', { first_upload: false }), '곡 나누기');
      showToast(`"${conti.title}" 다시 읽기 끝났어요.`, 'success');
    } catch (e) {
      await markFailed(contiId, `다시 읽기 실패: ${e.message}`);
      showToast(`다시 읽기 실패: ${e.message}`, 'error', 7000);
    } finally {
      ReprocessJobs.delete(contiId);
      LibState.modalDirty = true;
      if (typeof refreshAll === 'function') refreshAll();
    }
  })();
  return conti;
}
