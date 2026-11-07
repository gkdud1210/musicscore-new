/**
 * ScoreShift 서비스 워커 — "홈 화면에 추가"(앱 설치)를 위해 필요.
 * 악보·콘티는 항상 서버의 최신 내용을 보여줘야 하므로 캐시하지 않고 네트워크로 그대로 보낸다.
 * 인터넷이 끊겼을 때만 간단한 안내 화면을 보여준다.
 */
const OFFLINE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>오프라인</title></head>
<body style="background:#0a0a0f;color:#f0f0ff;font-family:sans-serif;display:flex;align-items:center;
justify-content:center;height:100vh;margin:0;text-align:center;padding:24px">
<div><div style="font-size:48px">📡</div><h2>인터넷에 연결되어 있지 않아요</h2>
<p style="color:#a0a0b8">연결된 뒤 다시 열어주세요.</p>
<button onclick="location.reload()" style="margin-top:12px;padding:10px 20px;border-radius:10px;border:0;background:#7c6bff;color:#fff;font-size:15px">다시 시도</button></div></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return; // 페이지 이동만 처리, 나머지는 브라우저 기본 동작
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  );
});
