"""
Claude로 악보 페이지 읽기 (선택 기능 — backend/.env 에 ANTHROPIC_API_KEY 가 있을 때만)

Tesseract OCR이 작은 스캔본에서 제목·키를 자주 틀리기 때문에, 관리자가 콘티 화면에서
"🤖 AI로 다시 인식"을 누르면 페이지 이미지를 Claude에 보내 제목/키/코드/가사를 받아온다.
결과는 ocr.analyze_page 와 같은 모양(dict)이라 곡 나누기(segment_songs) 이후 과정은 그대로 쓴다.

비용: 페이지마다 요청 1번 (이미지 1장 + 짧은 JSON 답).
"""

import base64
import io
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

import anthropic

from ocr import match_chord, normalize_key, render_page_image, zoom_for_width

logger = logging.getLogger("scoreshift.ai_ocr")

MODEL = "claude-opus-5-5"
MAX_IMAGE_EDGE = 1568        # 이보다 크면 API가 어차피 줄이므로 미리 줄여 보낸다
PARALLEL_PAGES = 4

SYSTEM_PROMPT = """You read pages of Korean worship song sheet music (찬양 악보) that were scanned or exported from a worship team's setlist (콘티) PDF.

For the single page image you are given, report:
- starts_new_song: true if a song title is printed at the top of this page (the start of a song). false if the page is a continuation of the previous page's song (no title, or only a small running header), or if it is not sheet music (cover, order of service, announcements).
- is_sheet_music: false for covers, order-of-service pages, lyric-only slides with no staff/chords, or blank pages.
- title: the song title exactly as printed (keep Korean as written, drop decorations like numbering, "Key", composer names, or copyright text). Empty string if there is no title.
- key: the song's key as a letter name, e.g. "G", "Bb", "F#m". Use an explicit marking if present ("Key: G", "G코드", "원키 A", "(D)", "사장조"). Otherwise infer it from the key signature and the chord symbols. Empty string only if there is no music.
- chords: chord symbols in reading order as printed (e.g. "G", "D/F#", "Em7", "Csus4"). Do not invent chords that are not printed.
- lyrics: the lyric text in reading order, one line per sung line, Korean as written. Do not include chord symbols, titles, or credits.

Answer with the JSON object only."""

PAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_sheet_music": {"type": "boolean"},
        "starts_new_song": {"type": "boolean"},
        "title": {"type": "string"},
        "key": {"type": "string"},
        "chords": {"type": "array", "items": {"type": "string"}},
        "lyrics": {"type": "string"},
    },
    "required": ["is_sheet_music", "starts_new_song", "title", "key", "chords", "lyrics"],
    "additionalProperties": False,
}

_client: Optional[anthropic.Anthropic] = None


def ai_available() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=3)  # ANTHROPIC_API_KEY 는 .env 에서 읽힘
    return _client


def _page_jpeg_b64(doc, page_index: int) -> str:
    img = render_page_image(doc, page_index, zoom=zoom_for_width(doc[page_index], MAX_IMAGE_EDGE))
    img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


def _analyze_rendered(image_b64: str, page_index: int, page_count: int) -> dict:
    """렌더링해 둔 페이지 이미지를 Claude로 읽어 ocr.analyze_page 와 같은 모양으로 돌려준다."""
    try:
        response = _get_client().beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM_PROMPT,
            output_config={
                "effort": "medium",
                "format": {"type": "json_schema", "schema": PAGE_SCHEMA},
            },
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}},
                    {"type": "text", "text": f"Page {page_index + 1} of {page_count}."},
                ],
            }],
        )
    except anthropic.AuthenticationError as e:
        raise RuntimeError("Claude API 키가 올바르지 않아요 (ANTHROPIC_API_KEY 확인)") from e
    except anthropic.PermissionDeniedError as e:
        raise RuntimeError("이 API 키로는 Claude를 쓸 수 없어요 (권한/결제 확인)") from e
    except anthropic.RateLimitError as e:
        raise RuntimeError("Claude 사용량 한도에 걸렸어요. 잠시 뒤 다시 시도해주세요") from e
    except anthropic.APIStatusError as e:
        raise RuntimeError(f"Claude API 오류 ({e.status_code})") from e
    except anthropic.APIConnectionError as e:
        raise RuntimeError("Claude API에 연결할 수 없어요 (인터넷 확인)") from e

    if response.stop_reason == "refusal":
        raise RuntimeError(f"Claude가 {page_index + 1}페이지 읽기를 거절했어요")
    if response.stop_reason == "max_tokens":
        raise RuntimeError(f"{page_index + 1}페이지 답이 너무 길어 잘렸어요")
    text = next((b.text for b in response.content if b.type == "text"), "")
    data = json.loads(text)

    chords = []
    for c in data.get("chords", []):
        m = match_chord(c)
        if m:
            chords.append(m)
    title = (data.get("title") or "").strip()
    is_music = bool(data.get("is_sheet_music"))
    return {
        "page_number": page_index + 1,
        "title_guess": title or None,
        # 표지·순서지는 새 곡으로 시작하게 해서 앞 곡에 붙지 않게 한다 (확인 화면에서 빼기)
        "has_title": bool(title) and bool(data.get("starts_new_song")) or not is_music,
        "key_explicit": normalize_key(data.get("key", "")) if is_music else "",
        "chords": chords,
        "lyrics_text": (data.get("lyrics") or "").strip(),
    }


def analyze_pdf_ai(doc, progress: Optional[Callable[[int, int], None]] = None) -> list:
    """모든 페이지를 몇 장씩 동시에 읽는다. 한 장이라도 실패하면 예외."""
    n = doc.page_count
    # PyMuPDF 문서는 스레드 간 공유가 안전하지 않으므로 렌더링은 순서대로, API 호출만 병렬로
    images = [_page_jpeg_b64(doc, i) for i in range(n)]
    results: list = [None] * n
    done = 0
    with ThreadPoolExecutor(max_workers=PARALLEL_PAGES) as pool:
        for i, page in pool.map(lambda i: (i, _analyze_rendered(images[i], i, n)), range(n)):
            results[i] = page
            done += 1
            if progress:
                progress(done, n)
    return results
