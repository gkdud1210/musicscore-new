"""
제미나이(Google Gemini)로 악보 페이지 읽기 — backend/.env 에 GEMINI_API_KEY 가 있으면
콘티를 올릴 때 기본 분석을 Tesseract 대신 제미나이로 한다.

- 서버는 페이지를 그림으로 만들어 보내기만 하므로 메모리를 적게 쓴다 (1GB 서버도 OK)
- 전에 읽은 같은 악보 페이지는 다시 보내지 않는다 (library._run_analysis 에서 걸러줌)
- 추가 설치 없음: 파이썬 기본 urllib 로 REST API 를 부른다
- 결과는 ocr.analyze_page 와 같은 모양(dict) → 곡 나누기 이후 과정은 그대로

모델은 GEMINI_MODEL 로 바꿀 수 있다 (기본: gemini-flash-latest = 빠르고 싼 최신 Flash).
"""

import base64
import io
import json
import logging
import os
import random
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional

from ocr import match_chord, normalize_key, render_page_image, zoom_for_width

logger = logging.getLogger("scoreshift.gemini_ocr")

DEFAULT_MODEL = "gemini-flash-latest"
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MAX_IMAGE_EDGE = 1600
PARALLEL_PAGES = 3          # 무료 사용량은 1분에 보낼 수 있는 횟수가 적어서 조금씩
# 생각(thinking)을 적게 해야 빠르다: 기본 모델로 한 쪽 37초 → 17초, 결과는 같았음 (2026-11-08)
# 이 설정을 모르는 모델이면 400 이 오므로 그때는 빼고 다시 보낸다
THINKING_LEVEL = os.getenv("GEMINI_THINKING", "low").strip()
_thinking_ok = {"value": bool(THINKING_LEVEL)}
MAX_TRIES = 6
TIMEOUT_SECONDS = 120

PROMPT = """You read one page of Korean worship song sheet music (찬양 악보), scanned or exported from a worship team's setlist (콘티) PDF.

Report as JSON:
- is_sheet_music: false for covers, order-of-service pages, announcements, lyric-only slides with no staff/chords, or blank pages.
- starts_new_song: true if a song title is printed at the top of this page (the start of a song). false if this page continues the previous page's song (no title, or only a small running header).
- title: the song title exactly as printed (keep Korean as written; drop numbering, "Key", composer names, copyright text). Empty string if there is no title.
- key: the song's key as a letter name, e.g. "G", "Bb", "F#m". Use an explicit marking if present ("Key: G", "G코드", "원키 A", "(D)"). Otherwise infer it from the key signature and chord symbols. Empty string only if there is no music.
- chords: chord symbols in reading order as printed (e.g. "G", "D/F#", "Em7"). Do not invent chords.
- lyrics: the lyric text in reading order, one sung line per line, Korean as written. No chords, titles or credits."""

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "is_sheet_music": {"type": "BOOLEAN"},
        "starts_new_song": {"type": "BOOLEAN"},
        "title": {"type": "STRING"},
        "key": {"type": "STRING"},
        "chords": {"type": "ARRAY", "items": {"type": "STRING"}},
        "lyrics": {"type": "STRING"},
    },
    "required": ["is_sheet_music", "starts_new_song", "title", "key", "chords", "lyrics"],
    "propertyOrdering": ["is_sheet_music", "starts_new_song", "title", "key", "chords", "lyrics"],
}


def gemini_available() -> bool:
    return bool(os.getenv("GEMINI_API_KEY", "").strip())


def _model() -> str:
    return os.getenv("GEMINI_MODEL", "").strip() or DEFAULT_MODEL


def _page_jpeg_b64(doc, page_index: int) -> str:
    img = render_page_image(doc, page_index, zoom=zoom_for_width(doc[page_index], MAX_IMAGE_EDGE))
    img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


def _call(image_b64: str, page_index: int, page_count: int) -> dict:
    gen = {
        "temperature": 0,
        "responseMimeType": "application/json",
        "responseSchema": RESPONSE_SCHEMA,
    }
    if _thinking_ok["value"]:
        gen["thinkingConfig"] = {"thinkingLevel": THINKING_LEVEL}
    body = json.dumps({
        "contents": [{"role": "user", "parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}},
            {"text": f"{PROMPT}\n\nThis is page {page_index + 1} of {page_count}."},
        ]}],
        "generationConfig": gen,
    }).encode("utf-8")
    req = urllib.request.Request(
        API_URL.format(model=_model()), data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "x-goog-api-key": os.getenv("GEMINI_API_KEY", "").strip()})

    for attempt in range(MAX_TRIES):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code == 400 and "thinking" in detail.lower() and _thinking_ok["value"]:
                logger.info(f"이 모델은 thinkingLevel={THINKING_LEVEL} 을 못 씀 → 빼고 다시")
                _thinking_ok["value"] = False
                return _call(image_b64, page_index, page_count)
            if e.code in (401, 403) or (e.code == 400 and "API key" in detail):
                raise RuntimeError("제미나이 API 키가 올바르지 않거나 권한이 없어요 (GEMINI_API_KEY 확인)") from e
            if e.code == 404:
                raise RuntimeError(f"제미나이 모델 '{_model()}'을 찾을 수 없어요 (GEMINI_MODEL 확인)") from e
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_TRIES - 1:
                wait = min(60, 5 * 2 ** attempt) + random.uniform(0, 2)
                logger.info(f"제미나이 {e.code} — {wait:.0f}초 뒤 다시 ({page_index + 1}쪽)")
                time.sleep(wait)
                continue
            if e.code == 429:
                raise RuntimeError("제미나이 사용량 한도에 걸렸어요. 잠시 뒤 다시 분석해주세요") from e
            raise RuntimeError(f"제미나이 API 오류 ({e.code}): {detail}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < MAX_TRIES - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError("제미나이에 연결할 수 없어요 (인터넷 확인)") from e

    cands = data.get("candidates") or []
    if not cands:
        reason = (data.get("promptFeedback") or {}).get("blockReason", "답 없음")
        raise RuntimeError(f"제미나이가 {page_index + 1}쪽을 읽지 못했어요 ({reason})")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"제미나이 답을 읽을 수 없어요 ({page_index + 1}쪽, {cands[0].get('finishReason')})") from e


def _to_page(data: dict, page_index: int) -> dict:
    chords = []
    for c in data.get("chords") or []:
        m = match_chord(str(c))
        if m:
            chords.append(m)
    title = (data.get("title") or "").strip()
    is_music = bool(data.get("is_sheet_music"))
    return {
        "page_number": page_index + 1,
        "title_guess": title or None,
        # 표지·순서지는 새 곡으로 시작하게 해서 앞 곡에 붙지 않게 한다 (확인 화면에서 빼기)
        "has_title": (bool(title) and bool(data.get("starts_new_song"))) or not is_music,
        "key_explicit": normalize_key(data.get("key") or "") if is_music else "",
        "chords": chords,
        "lyrics_text": (data.get("lyrics") or "").strip(),
    }


def analyze_pages_gemini(doc, indices: List[int],
                         progress: Optional[Callable[[int, int], None]] = None) -> Dict[int, dict]:
    """indices(0부터) 페이지만 읽어서 {페이지 index: page dict}. 한 장이라도 실패하면 예외."""
    n = doc.page_count
    # PyMuPDF 문서는 스레드 간 공유가 안전하지 않으므로 그림 만들기는 차례로, API 호출만 동시에
    images = {i: _page_jpeg_b64(doc, i) for i in indices}
    out: Dict[int, dict] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=PARALLEL_PAGES) as pool:
        for i, data in pool.map(lambda i: (i, _call(images[i], i, n)), indices):
            out[i] = _to_page(data, i)
            done += 1
            if progress:
                progress(done, len(indices))
    return out
