"""
악보(콘티) 라이브러리 API

콘티 PDF 업로드 → 페이지별 OCR → 곡 단위 분리(제목/키/가사/코드)
→ 곡 검색(제목·가사·키·코드) → 곡 선택 → 새 콘티 PDF로 내보내기
+ 기존 기능: 콘티 PDF 뷰어, 페이지별 필기 저장, 필기 반영 PDF 내보내기
"""

import hashlib
import io
import json
import logging
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import List, Optional
from urllib.parse import quote

import fitz
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from auth import role_from_request
from db import SCORES_DIR, get_conn, score_dir
from ocr import (
    _norm_title,
    analyze_page as ocr_analyze_page,
    analyze_pdf,
    build_song_meta,
    generate_thumbnail,
    normalize_key,
    render_page_image,
    segment_songs,
    zoom_for_width,
)

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
PAGE_IMAGE_WIDTH = 1400   # 화면에 보여줄 페이지 이미지 폭(px)


# ═══════════════════════════════════════════════════════════════
#   Pydantic 모델
# ═══════════════════════════════════════════════════════════════

class SongBrief(BaseModel):
    id: int
    title: str
    key: str
    key_source: str
    page_start: int
    page_end: int


class ScoreSummary(BaseModel):
    id: int
    title: str
    page_count: int
    chords: List[str]
    thumbnail_url: str
    created_at: str
    updated_at: str
    conti_date: Optional[str] = None
    original_filename: Optional[str] = None
    songs: List[SongBrief] = []
    duplicate: bool = False   # 같은 파일을 이미 올려서 새로 저장하지 않았음
    confirmed: bool = True    # False면 업로드 후 아직 확인 전 → 검색에 안 나옴
    status: str = "ready"     # processing(분석 중) | ready | error
    status_detail: str = ""   # 진행 상황("3/13") 또는 오류 메시지


class ScoreDetail(ScoreSummary):
    lyrics_text: str


class ScoreUpdateRequest(BaseModel):
    title: Optional[str] = None
    chords: Optional[List[str]] = None
    conti_date: Optional[str] = None


class Song(BaseModel):
    id: int
    title: str
    key: str
    key_source: str
    chords: List[str]
    score_id: int
    conti_title: str
    conti_date: Optional[str] = None
    page_start: int
    page_end: int
    image_urls: List[str]
    lyrics_snippet: str = ""


class SongUpdateRequest(BaseModel):
    title: Optional[str] = None
    key: Optional[str] = None


class SongCreateRequest(BaseModel):
    page_start: int
    page_end: int


class SplitRequest(BaseModel):
    page: int


class ConfirmRequest(BaseModel):
    confirmed: bool = True


class SetlistExportRequest(BaseModel):
    song_ids: List[int]
    title: Optional[str] = None
    include_annotations: bool = True


class AnnotationPayload(BaseModel):
    strokes: List[dict] = []


# ═══════════════════════════════════════════════════════════════
#   헬퍼
# ═══════════════════════════════════════════════════════════════

DATE_PATTERNS = [
    re.compile(r'(20\d{2})[.\-_/년\s]+(\d{1,2})[.\-_/월\s]+(\d{1,2})'),
    re.compile(r'(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)'),
    re.compile(r'(?<!\d)(\d{2})[.\-_/](\d{1,2})[.\-_/](\d{1,2})(?!\d)'),
    re.compile(r'(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)'),
]


def guess_date_from_filename(name: str) -> Optional[str]:
    """'2024.03.10 주일예배.pdf', '240310_콘티.pdf' 같은 파일명에서 날짜를 뽑는다."""
    for pat in DATE_PATTERNS:
        m = pat.search(name or "")
        if not m:
            continue
        y, mo, d = m.groups()
        y = int(y) + (2000 if len(y) == 2 else 0)
        mo, d = int(mo), int(d)
        if 1 <= mo <= 12 and 1 <= d <= 31 and 2000 <= y <= 2100:
            return f"{y:04d}-{mo:02d}-{d:02d}"
    # 연도 없이 "11월6일", "11월 6일" → 오늘 기준 가장 최근의 그 날짜 (미래면 작년)
    m = re.search(r'(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일', name or "")
    if m:
        mo, d = int(m.group(1)), int(m.group(2))
        if 1 <= mo <= 12 and 1 <= d <= 31:
            today = date.today()
            y = today.year if (mo, d) <= (today.month, today.day) else today.year - 1
            try:
                return date(y, mo, d).isoformat()
            except ValueError:
                return None
    return None


def content_disposition(filename: str) -> str:
    """한글 파일명은 RFC 5987 filename* 로 보내야 헤더 인코딩 에러가 나지 않는다."""
    safe = "".join(c for c in filename if c not in '/\\:*?"<>|\r\n') or "score.pdf"
    ascii_fallback = re.sub(r'[^A-Za-z0-9._-]', '_', safe) or "score.pdf"
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(safe)}"


def _hex_to_rgb01(hex_str: str):
    hex_str = (hex_str or "#ff3b30").lstrip("#")
    if len(hex_str) != 6:
        hex_str = "ff3b30"
    return tuple(int(hex_str[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _draw_strokes(page: "fitz.Page", strokes: list):
    if not strokes:
        return
    pw, ph = page.rect.width, page.rect.height
    shape = page.new_shape()
    drew = False
    for stroke in strokes:
        points = stroke.get("points") or []
        if len(points) < 2:
            continue
        shape.draw_polyline([(px * pw, py * ph) for px, py in points])
        shape.finish(
            color=_hex_to_rgb01(stroke.get("color")),
            width=max(float(stroke.get("width_ratio", 0.004)) * pw, 0.5),
            stroke_opacity=0.35 if stroke.get("tool") == "highlighter" else 1.0,
            closePath=False,
        )
        drew = True
    if drew:
        shape.commit(overlay=True)


def _pdf_path(score_id: int) -> str:
    return os.path.join(score_dir(score_id), "original.pdf")


def _song_rows_for_score(conn, score_id: int):
    return conn.execute(
        "SELECT * FROM songs WHERE score_id = ? ORDER BY page_start", (score_id,)
    ).fetchall()


def _song_brief(r) -> SongBrief:
    return SongBrief(id=r["id"], title=r["title"], key=r["song_key"], key_source=r["key_source"],
                     page_start=r["page_start"], page_end=r["page_end"])


def _row_to_summary(conn, row) -> ScoreSummary:
    chords = [r["chord"] for r in conn.execute(
        "SELECT chord FROM score_chords WHERE score_id = ? ORDER BY chord", (row["id"],))]
    return ScoreSummary(
        id=row["id"],
        title=row["title"],
        page_count=row["page_count"],
        chords=chords,
        thumbnail_url=f"/api/scores/{row['id']}/thumbnail",
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        conti_date=row["conti_date"],
        original_filename=row["original_filename"],
        confirmed=bool(row["confirmed"]),
        status=row["status"],
        status_detail=row["status_detail"],
        songs=[_song_brief(s) for s in _song_rows_for_score(conn, row["id"])],
    )


def get_score_row(score_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM scores WHERE id = ?", (score_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "콘티를 찾을 수 없습니다")
        return row


def get_score_summary(score_id: int) -> ScoreSummary:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM scores WHERE id = ?", (score_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "콘티를 찾을 수 없습니다")
        return _row_to_summary(conn, row)


def _page_dicts(conn, score_id: int, start: int, end: int) -> list:
    rows = conn.execute(
        "SELECT * FROM pages WHERE score_id = ? AND page_number BETWEEN ? AND ? ORDER BY page_number",
        (score_id, start, end),
    ).fetchall()
    return [{
        "page_number": r["page_number"],
        "title_guess": r["title_guess"],
        "has_title": bool(r["has_title"]),
        "key_explicit": r["key_explicit"] or "",
        "chords": json.loads(r["chords_json"] or "[]"),
        "lyrics_text": r["lyrics_text"] or "",
    } for r in rows]


def _recompute_song(conn, song_id: int):
    """페이지 범위가 바뀐 곡의 가사/코드(+수동 수정이 아니면 제목/키)를 다시 계산."""
    s = conn.execute("SELECT * FROM songs WHERE id = ?", (song_id,)).fetchone()
    pages = _page_dicts(conn, s["score_id"], s["page_start"], s["page_end"])
    if not pages:
        return
    meta = build_song_meta(pages)
    title = s["title"] if s["title_manual"] else meta["title"]
    key, src = (s["song_key"], s["key_source"]) if s["key_source"] == "manual" else (meta["song_key"], meta["key_source"])
    conn.execute(
        "UPDATE songs SET title=?, song_key=?, key_source=?, lyrics_text=?, chords_text=? WHERE id=?",
        (title, key, src, meta["lyrics_text"], " ".join(meta["chords"]), song_id),
    )


def _insert_song(conn, score_id: int, start: int, end: int) -> int:
    cur = conn.execute(
        "INSERT INTO songs (score_id, page_start, page_end) VALUES (?, ?, ?)", (score_id, start, end))
    _recompute_song(conn, cur.lastrowid)
    return cur.lastrowid


def _analyze_and_store(conn, score_id: int, doc: "fitz.Document", pages=None):
    """페이지 분석 → pages 저장 → 곡 분리 → songs 저장. 기존 pages/songs는 지운다.

    OCR(analyze_pdf)은 스캔본이면 몇 분 걸린다. 그동안 DB 쓰기 잠금을 잡고 있으면
    다른 요청(곡 이름 수정, 다른 업로드)이 전부 'database is locked'로 실패하므로,
    호출하는 쪽에서 쓰기 전에 미리 분석해서 pages로 넘긴다."""
    if pages is None:
        pages = analyze_pdf(doc)
    conn.execute("DELETE FROM pages WHERE score_id = ?", (score_id,))
    conn.execute("DELETE FROM songs WHERE score_id = ?", (score_id,))
    conn.execute("DELETE FROM score_chords WHERE score_id = ?", (score_id,))
    conn.executemany(
        "INSERT INTO pages (score_id, page_number, title_guess, has_title, key_explicit, chords_json, lyrics_text)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(score_id, p["page_number"], p["title_guess"], int(p["has_title"]), p["key_explicit"],
          json.dumps(p["chords"], ensure_ascii=False), p["lyrics_text"]) for p in pages],
    )
    for start, end in segment_songs(pages):
        _insert_song(conn, score_id, start, end)

    all_chords = sorted({c for p in pages for c in p["chords"]})
    conn.executemany("INSERT OR IGNORE INTO score_chords (score_id, chord) VALUES (?, ?)",
                     [(score_id, c) for c in all_chords])
    conn.execute(
        "UPDATE scores SET lyrics_text = ?, page_count = ?, updated_at = datetime('now') WHERE id = ?",
        ("\n".join(p["lyrics_text"] for p in pages), doc.page_count, score_id),
    )


def _clear_page_cache(score_id: int):
    shutil.rmtree(os.path.join(score_dir(score_id), "pages"), ignore_errors=True)


# ═══════════════════════════════════════════════════════════════
#   콘티 업로드 / 목록 / 상세 / 수정 / 삭제 / 재분석
# ═══════════════════════════════════════════════════════════════

@router.post("/scores", response_model=ScoreSummary)
def upload_score(file: UploadFile = File(...)):
    filename = file.filename or "conti.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDF 파일만 업로드할 수 있습니다")

    contents = file.file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "파일 크기가 100MB를 초과합니다")

    try:
        doc = fitz.open(stream=contents, filetype="pdf")
    except Exception as e:
        raise HTTPException(400, f"PDF를 열 수 없습니다: {e}")
    if doc.page_count == 0:
        doc.close()
        raise HTTPException(400, "빈 PDF입니다")

    stem = os.path.splitext(os.path.basename(filename))[0]
    page_count = doc.page_count
    file_hash = hashlib.sha256(contents).hexdigest()
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM scores WHERE file_hash = ?", (file_hash,)).fetchone()
    if existing:
        doc.close()
        logger.info(f"📚 이미 있는 콘티 (중복 업로드): [{existing['id']}] {filename}")
        return get_score_summary(existing["id"]).model_copy(update={"duplicate": True})

    try:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO scores (title, original_filename, page_count, conti_date, file_hash, confirmed,"
                " status, status_detail) VALUES (?, ?, ?, ?, ?, 0, 'processing', '대기 중')",
                (stem, filename, page_count, guess_date_from_filename(stem), file_hash),
            )
            score_id = cur.lastrowid
            with open(os.path.join(score_dir(score_id), "original.pdf"), "wb") as f:
                f.write(contents)
            conn.commit()
        try:
            generate_thumbnail(doc, os.path.join(score_dir(score_id), "thumbnail.png"))
        except Exception as e:
            logger.warning(f"썸네일 생성 실패: {e}")
    finally:
        doc.close()

    # 분석(스캔본은 몇 분)은 백그라운드에서 — Cloudflare가 100초 넘는 요청을 끊기 때문에
    # 바로 응답하고, 화면은 status 가 processing 이 아닐 때까지 확인한다
    enqueue_analysis(score_id, "ocr", first_upload=True)
    logger.info(f"📚 콘티 업로드: [{score_id}] {stem} ({page_count}p) → 분석 대기")
    return get_score_summary(score_id)


# ═══════════════════════════════════════════════════════════════
#   백그라운드 분석 (OCR / Claude AI) — 한 번에 하나씩 차례대로
# ═══════════════════════════════════════════════════════════════

_analysis_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analyze")


def _set_status(score_id: int, status: str, detail: str = ""):
    with get_conn() as conn:
        conn.execute("UPDATE scores SET status = ?, status_detail = ? WHERE id = ?", (status, detail[:300], score_id))
        conn.commit()


def enqueue_analysis(score_id: int, engine: str = "ocr", first_upload: bool = False):
    _set_status(score_id, "processing", "대기 중")
    _analysis_pool.submit(_run_analysis, score_id, engine, first_upload)


def _run_analysis(score_id: int, engine: str, first_upload: bool):
    label = "AI 인식" if engine == "ai" else "인식"
    try:
        doc = fitz.open(_pdf_path(score_id))
    except Exception as e:
        logger.error(f"[{score_id}] PDF 열기 실패: {e}")
        _set_status(score_id, "error", f"PDF를 열 수 없어요: {e}")
        return
    try:
        n = doc.page_count
        progress = lambda done, total: _set_status(score_id, "processing", f"{label} {done}/{total}쪽")
        if engine == "ai":
            from ai_ocr import analyze_pdf_ai
            _set_status(score_id, "processing", f"{label} 준비 중")
            pages = analyze_pdf_ai(doc, progress)
        else:
            pages = []
            for i in range(n):
                progress(i, n)
                pages.append(ocr_analyze_page(doc, i))
        _clear_page_cache(score_id)
        with get_conn() as conn:
            _analyze_and_store(conn, score_id, doc, pages)
            row = conn.execute("SELECT title, conti_date FROM scores WHERE id = ?", (score_id,)).fetchone()
            if first_upload and row and not row["conti_date"] and pages:
                # 파일명에 날짜가 없으면 첫 페이지(표지/순서지) 글자에서 찾아본다
                p1 = pages[0]
                d_guess = guess_date_from_filename(f"{p1['title_guess'] or ''}\n{p1['lyrics_text']}")
                if d_guess:
                    conn.execute("UPDATE scores SET conti_date = ? WHERE id = ?", (d_guess, score_id))
            conn.execute("UPDATE scores SET status = 'ready', status_detail = '' WHERE id = ?", (score_id,))
            conn.commit()
        logger.info(f"📚 [{score_id}] {label} 완료 ({n}p)")
    except Exception as e:
        logger.exception(f"[{score_id}] {label} 실패")
        with get_conn() as conn:
            if not conn.execute("SELECT 1 FROM songs WHERE score_id = ?", (score_id,)).fetchone():
                # 분석이 실패해도 콘티는 남기고, 페이지마다 곡 1개로 등록해 수동 보정할 수 있게 한다
                for p in range(1, doc.page_count + 1):
                    conn.execute("INSERT INTO songs (score_id, page_start, page_end) VALUES (?, ?, ?)",
                                 (score_id, p, p))
            conn.execute("UPDATE scores SET status = 'error', status_detail = ? WHERE id = ?",
                         (f"{label} 실패: {e}"[:300], score_id))
            conn.commit()
    finally:
        doc.close()


def resume_pending_analysis():
    """서버가 분석 도중에 다시 켜졌으면 하던 분석을 다시 시작한다."""
    with get_conn() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM scores WHERE status = 'processing'")]
    for sid in ids:
        logger.info(f"[{sid}] 끊긴 분석 다시 시작")
        enqueue_analysis(sid, "ocr", first_upload=True)


@router.get("/scores", response_model=List[ScoreSummary])
def list_scores(request: Request, q: Optional[str] = Query(None)):
    where, params = [], []
    if q:
        where.append("(title LIKE ? OR original_filename LIKE ? OR id IN (SELECT score_id FROM songs WHERE title LIKE ?))")
        params = [f"%{q}%"] * 3
    if role_from_request(request) != "admin":
        where.append("confirmed = 1")  # 확인 전 콘티는 관리자에게만 보인다
    sql = "SELECT * FROM scores" + (" WHERE " + " AND ".join(where) if where else "")
    sql += " ORDER BY confirmed, (conti_date IS NULL), conti_date DESC, created_at DESC"
    with get_conn() as conn:
        return [_row_to_summary(conn, r) for r in conn.execute(sql, params).fetchall()]


@router.get("/scores/{score_id}", response_model=ScoreDetail)
def get_score(score_id: int):
    s = get_score_summary(score_id)
    row = get_score_row(score_id)
    return ScoreDetail(**s.model_dump(), lyrics_text=row["lyrics_text"])


@router.patch("/scores/{score_id}", response_model=ScoreSummary)
def update_score(score_id: int, req: ScoreUpdateRequest):
    get_score_row(score_id)
    with get_conn() as conn:
        if req.title is not None:
            conn.execute("UPDATE scores SET title = ?, updated_at = datetime('now') WHERE id = ?",
                         (req.title.strip() or "제목 없는 콘티", score_id))
        if req.conti_date is not None:
            conn.execute("UPDATE scores SET conti_date = ?, updated_at = datetime('now') WHERE id = ?",
                         (req.conti_date.strip() or None, score_id))
        if req.chords is not None:
            conn.execute("DELETE FROM score_chords WHERE score_id = ?", (score_id,))
            conn.executemany("INSERT OR IGNORE INTO score_chords (score_id, chord) VALUES (?, ?)",
                             [(score_id, c) for c in sorted({c.strip() for c in req.chords if c.strip()})])
        conn.commit()
    return get_score_summary(score_id)


@router.post("/scores/{score_id}/confirm", response_model=ScoreSummary)
def confirm_score(score_id: int, req: ConfirmRequest = ConfirmRequest()):
    """업로드 확인 완료 → 라이브러리(검색)에 넣는다. confirmed=false면 다시 확인 대기로."""
    get_score_row(score_id)
    with get_conn() as conn:
        conn.execute("UPDATE scores SET confirmed = ?, updated_at = datetime('now') WHERE id = ?",
                     (int(req.confirmed), score_id))
        conn.commit()
    return get_score_summary(score_id)


@router.delete("/scores/{score_id}")
def delete_score(score_id: int):
    get_score_row(score_id)
    with get_conn() as conn:
        conn.execute("DELETE FROM scores WHERE id = ?", (score_id,))
        conn.commit()
    d = os.path.join(SCORES_DIR, str(score_id))
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    return {"success": True}


@router.post("/scores/{score_id}/reprocess", response_model=ScoreSummary)
def reprocess_score(score_id: int, engine: str = Query("ocr", pattern="^(ocr|ai)$")):
    """콘티를 처음부터 다시 분석 (곡 분리/제목/키를 수동으로 고친 내용은 사라진다).
    engine=ai 면 Claude로 읽는다 (ANTHROPIC_API_KEY 필요). 백그라운드에서 돌고 바로 응답한다."""
    row = get_score_row(score_id)
    if row["status"] == "processing":
        raise HTTPException(409, "이미 분석 중이에요. 끝날 때까지 기다려주세요")
    if not os.path.isfile(_pdf_path(score_id)):
        raise HTTPException(404, "PDF 파일을 찾을 수 없습니다")
    if engine == "ai":
        from ai_ocr import ai_available
        if not ai_available():
            raise HTTPException(400, "AI 인식을 쓰려면 서버에 Claude API 키(ANTHROPIC_API_KEY)를 넣어야 해요")
    enqueue_analysis(score_id, engine)
    return get_score_summary(score_id)


@router.get("/ai-status")
def ai_status():
    from ai_ocr import ai_available
    return {"available": ai_available()}


# ═══════════════════════════════════════════════════════════════
#   곡 검색 / 수정 / 곡 경계 보정
# ═══════════════════════════════════════════════════════════════

def _song_from_row(r) -> Song:
    lyrics = (r["lyrics_text"] or "").replace("\n", " ")
    return Song(
        id=r["id"],
        title=r["title"],
        key=r["song_key"],
        key_source=r["key_source"],
        chords=(r["chords_text"] or "").split(),
        score_id=r["score_id"],
        conti_title=r["conti_title"],
        conti_date=r["conti_date"],
        page_start=r["page_start"],
        page_end=r["page_end"],
        image_urls=[f"/api/scores/{r['score_id']}/pages/{n}/image"
                    for n in range(r["page_start"], r["page_end"] + 1)],
        lyrics_snippet=lyrics[:120],
    )


SONG_SELECT = """
    SELECT so.*, sc.title AS conti_title, sc.conti_date AS conti_date
    FROM songs so JOIN scores sc ON sc.id = so.score_id
"""


@router.get("/songs", response_model=List[Song])
def search_songs(
    q: Optional[str] = Query(None, description="제목/가사 검색 (띄어쓰기 무시)"),
    key: Optional[str] = Query(None, description="키(조) 필터, 쉼표 구분. 예: G,A"),
    chords: Optional[str] = Query(None, description="포함 코드 필터, 쉼표 구분 (모두 포함)"),
    score_id: Optional[int] = Query(None),
):
    where, params = [], []
    if q and q.strip():
        compact = re.sub(r"\s+", "", q.strip()).lower()
        nq = f"%{compact}%"
        where.append(
            "(lower(replace(replace(so.title, ' ', ''), char(10), '')) LIKE ?"
            " OR lower(replace(replace(so.lyrics_text, ' ', ''), char(10), '')) LIKE ?)"
        )
        params += [nq, nq]
    if key:
        keys = [normalize_key(k) for k in key.split(",") if k.strip()]
        if keys:
            where.append(f"so.song_key IN ({','.join('?' for _ in keys)})")
            params += keys
    if chords:
        for c in [c.strip() for c in chords.split(",") if c.strip()]:
            where.append("(' ' || so.chords_text || ' ') LIKE ?")
            params.append(f"% {c} %")
    if score_id is not None:
        where.append("so.score_id = ?")
        params.append(score_id)
    else:
        where.append("sc.confirmed = 1")  # 라이브러리 검색에는 확인된 콘티의 곡만

    sql = SONG_SELECT + (" WHERE " + " AND ".join(where) if where else "")
    sql += " ORDER BY so.title COLLATE NOCASE, (sc.conti_date IS NULL), sc.conti_date DESC, so.id DESC"
    with get_conn() as conn:
        return [_song_from_row(r) for r in conn.execute(sql, params).fetchall()]


@router.get("/songs/facets")
def song_facets():
    """키별 곡 수, 코드 목록 — 필터 칩용."""
    with get_conn() as conn:
        ok = "score_id IN (SELECT id FROM scores WHERE confirmed = 1)"
        keys = [{"key": r["song_key"], "count": r["n"]} for r in conn.execute(
            f"SELECT song_key, COUNT(*) AS n FROM songs WHERE song_key != '' AND {ok} GROUP BY song_key")]
        chord_set = set()
        for r in conn.execute(f"SELECT chords_text FROM songs WHERE {ok}"):
            chord_set.update((r["chords_text"] or "").split())
        total = conn.execute(f"SELECT COUNT(*) FROM songs WHERE {ok}").fetchone()[0]
    return {"keys": keys, "chords": sorted(chord_set), "total": total}


def _get_song_row(conn, song_id: int):
    r = conn.execute(SONG_SELECT + " WHERE so.id = ?", (song_id,)).fetchone()
    if r is None:
        raise HTTPException(404, "곡을 찾을 수 없습니다")
    return r


@router.get("/songs/{song_id}", response_model=Song)
def get_song(song_id: int):
    with get_conn() as conn:
        return _song_from_row(_get_song_row(conn, song_id))


@router.patch("/songs/{song_id}", response_model=Song)
def update_song(song_id: int, req: SongUpdateRequest):
    with get_conn() as conn:
        _get_song_row(conn, song_id)
        if req.title is not None:
            conn.execute("UPDATE songs SET title = ?, title_manual = 1 WHERE id = ?",
                         (req.title.strip() or "제목 없음", song_id))
        if req.key is not None:
            k = normalize_key(req.key)
            conn.execute("UPDATE songs SET song_key = ?, key_source = ? WHERE id = ?",
                         (k, "manual" if k else "", song_id))
        conn.commit()
        return _song_from_row(_get_song_row(conn, song_id))


@router.delete("/songs/{song_id}")
def delete_song(song_id: int):
    """곡 목록에서만 뺀다 (예: 표지/순서지 페이지). PDF 원본은 그대로."""
    with get_conn() as conn:
        _get_song_row(conn, song_id)
        conn.execute("DELETE FROM songs WHERE id = ?", (song_id,))
        conn.commit()
    return {"success": True}


@router.post("/songs/{song_id}/merge-prev", response_model=ScoreSummary)
def merge_with_previous(song_id: int):
    """이 곡을 바로 앞 곡에 합친다 (2페이지짜리 곡이 둘로 나뉘었을 때)."""
    with get_conn() as conn:
        s = _get_song_row(conn, song_id)
        prev = conn.execute(
            "SELECT * FROM songs WHERE score_id = ? AND page_start < ? ORDER BY page_start DESC LIMIT 1",
            (s["score_id"], s["page_start"]),
        ).fetchone()
        if prev is None:
            raise HTTPException(400, "앞에 합칠 곡이 없습니다")
        conn.execute("UPDATE songs SET page_end = ? WHERE id = ?", (max(prev["page_end"], s["page_end"]), prev["id"]))
        conn.execute("DELETE FROM songs WHERE id = ?", (song_id,))
        _recompute_song(conn, prev["id"])
        conn.commit()
        score_id = s["score_id"]
    return get_score_summary(score_id)


@router.post("/songs/{song_id}/split", response_model=ScoreSummary)
def split_song(song_id: int, req: SplitRequest):
    """page 부터 새 곡으로 나눈다."""
    with get_conn() as conn:
        s = _get_song_row(conn, song_id)
        if not (s["page_start"] < req.page <= s["page_end"]):
            raise HTTPException(400, "나눌 페이지가 곡 범위 밖입니다")
        conn.execute("UPDATE songs SET page_end = ? WHERE id = ?", (req.page - 1, song_id))
        _recompute_song(conn, song_id)
        _insert_song(conn, s["score_id"], req.page, s["page_end"])
        conn.commit()
        score_id = s["score_id"]
    return get_score_summary(score_id)


@router.post("/songs/{song_id}/remove-page", response_model=ScoreSummary)
def remove_page_from_song(song_id: int, req: SplitRequest):
    """곡에서 페이지 하나만 뺀다 (잘못 붙은 악보 등). 빠진 페이지는 '곡에 포함되지 않은
    페이지'로 남아서 나중에 다시 곡으로 추가할 수 있다. 가운데 페이지면 앞뒤로 나뉜다."""
    with get_conn() as conn:
        s = _get_song_row(conn, song_id)
        start, end, p = s["page_start"], s["page_end"], req.page
        if not (start <= p <= end):
            raise HTTPException(400, "곡 범위 밖의 페이지입니다")
        if start == end:
            conn.execute("DELETE FROM songs WHERE id = ?", (song_id,))
        elif p == start:
            conn.execute("UPDATE songs SET page_start = ? WHERE id = ?", (p + 1, song_id))
            _recompute_song(conn, song_id)
        elif p == end:
            conn.execute("UPDATE songs SET page_end = ? WHERE id = ?", (p - 1, song_id))
            _recompute_song(conn, song_id)
        else:
            conn.execute("UPDATE songs SET page_end = ? WHERE id = ?", (p - 1, song_id))
            _recompute_song(conn, song_id)
            _insert_song(conn, s["score_id"], p + 1, end)
        conn.commit()
        score_id = s["score_id"]
    return get_score_summary(score_id)


@router.post("/scores/{score_id}/songs", response_model=ScoreSummary)
def add_song(score_id: int, req: SongCreateRequest):
    """곡에 속하지 않은 페이지를 곡으로 등록 (삭제했던 페이지 되살리기 등)."""
    row = get_score_row(score_id)
    if not (1 <= req.page_start <= req.page_end <= row["page_count"]):
        raise HTTPException(400, "페이지 범위가 잘못됐습니다")
    with get_conn() as conn:
        overlap = conn.execute(
            "SELECT 1 FROM songs WHERE score_id = ? AND page_start <= ? AND page_end >= ?",
            (score_id, req.page_end, req.page_start),
        ).fetchone()
        if overlap:
            raise HTTPException(400, "이미 다른 곡에 속한 페이지입니다")
        _insert_song(conn, score_id, req.page_start, req.page_end)
        conn.commit()
    return get_score_summary(score_id)


# ═══════════════════════════════════════════════════════════════
#   새 콘티 PDF 내보내기 (선택한 곡들을 순서대로 이어붙임)
# ═══════════════════════════════════════════════════════════════

@router.post("/setlist/export")
def export_setlist(req: SetlistExportRequest):
    if not req.song_ids:
        raise HTTPException(400, "선택한 곡이 없습니다")

    with get_conn() as conn:
        songs = []
        for sid in req.song_ids:
            r = conn.execute("SELECT * FROM songs WHERE id = ?", (sid,)).fetchone()
            if r is None:
                raise HTTPException(404, f"곡을 찾을 수 없습니다 (id={sid})")
            songs.append(r)
        annots = {}
        if req.include_annotations:
            score_ids = {s["score_id"] for s in songs}
            for sc in score_ids:
                for a in conn.execute("SELECT page_number, strokes_json FROM annotations WHERE score_id = ?", (sc,)):
                    annots[(sc, a["page_number"])] = json.loads(a["strokes_json"] or "[]")

    out = fitz.open()
    sources = {}
    try:
        for s in songs:
            sc = s["score_id"]
            if sc not in sources:
                path = _pdf_path(sc)
                if not os.path.isfile(path):
                    raise HTTPException(404, f"원본 PDF가 없습니다 (콘티 id={sc})")
                sources[sc] = fitz.open(path)
            src = sources[sc]
            start = max(1, s["page_start"])
            end = min(src.page_count, s["page_end"])
            out.insert_pdf(src, from_page=start - 1, to_page=end - 1)
            first_new = out.page_count - (end - start + 1)
            for offset, n in enumerate(range(start, end + 1)):
                strokes = annots.get((sc, n))
                if strokes:
                    _draw_strokes(out[first_new + offset], strokes)
        # PDF 책갈피: 곡마다 시작 페이지
        toc, page = [], 1
        for s in songs:
            toc.append([1, s["title"], page])
            page += s["page_end"] - s["page_start"] + 1
        out.set_toc(toc)
        pdf_bytes = out.tobytes(garbage=4, deflate=True)
    finally:
        out.close()
        for d in sources.values():
            d.close()

    title = (req.title or "").strip() or "새 콘티"
    return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf",
                             headers={"Content-Disposition": content_disposition(f"{title}.pdf")})


# ═══════════════════════════════════════════════════════════════
#   파일 서빙
# ═══════════════════════════════════════════════════════════════

@router.get("/scores/{score_id}/file")
def get_score_file(score_id: int):
    get_score_row(score_id)
    path = _pdf_path(score_id)
    if not os.path.isfile(path):
        raise HTTPException(404, "PDF 파일을 찾을 수 없습니다")
    return FileResponse(path, media_type="application/pdf")


@router.get("/scores/{score_id}/thumbnail")
def get_score_thumbnail(score_id: int):
    get_score_row(score_id)
    path = os.path.join(score_dir(score_id), "thumbnail.png")
    if not os.path.isfile(path):
        raise HTTPException(404, "썸네일이 없습니다")
    return FileResponse(path, media_type="image/png")


@router.get("/scores/{score_id}/pages/{page_number}/image")
def get_page_image(score_id: int, page_number: int):
    """페이지 1장을 JPEG로 (처음 요청 때 렌더링해서 디스크에 캐시)."""
    row = get_score_row(score_id)
    if not (1 <= page_number <= row["page_count"]):
        raise HTTPException(404, "페이지 번호가 범위를 벗어났습니다")
    cache_dir = os.path.join(score_dir(score_id), "pages")
    path = os.path.join(cache_dir, f"{page_number}.jpg")
    if not os.path.isfile(path):
        os.makedirs(cache_dir, exist_ok=True)
        doc = fitz.open(_pdf_path(score_id))
        try:
            img = render_page_image(doc, page_number - 1, zoom=zoom_for_width(doc[page_number - 1], PAGE_IMAGE_WIDTH))
        finally:
            doc.close()
        tmp = path + ".tmp"
        img.save(tmp, format="JPEG", quality=82, optimize=True)
        os.replace(tmp, path)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


# ═══════════════════════════════════════════════════════════════
#   페이지별 필기(annotation)
# ═══════════════════════════════════════════════════════════════

@router.get("/scores/{score_id}/annotations/{page_number}")
def get_annotations(score_id: int, page_number: int):
    get_score_row(score_id)
    with get_conn() as conn:
        row = conn.execute(
            "SELECT strokes_json FROM annotations WHERE score_id = ? AND page_number = ?",
            (score_id, page_number),
        ).fetchone()
    return {"strokes": json.loads(row["strokes_json"]) if row else []}


@router.put("/scores/{score_id}/annotations/{page_number}")
def put_annotations(score_id: int, page_number: int, payload: AnnotationPayload):
    get_score_row(score_id)
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO annotations (score_id, page_number, strokes_json, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(score_id, page_number)
            DO UPDATE SET strokes_json = excluded.strokes_json, updated_at = excluded.updated_at
            """,
            (score_id, page_number, json.dumps(payload.strokes)),
        )
        conn.commit()
    return {"success": True}


@router.get("/scores/{score_id}/export")
def export_score(score_id: int):
    """콘티 전체를 필기가 반영된 PDF로 내보내기."""
    row = get_score_row(score_id)
    pdf_path = _pdf_path(score_id)
    if not os.path.isfile(pdf_path):
        raise HTTPException(404, "PDF 파일을 찾을 수 없습니다")
    with get_conn() as conn:
        annot_rows = conn.execute(
            "SELECT page_number, strokes_json FROM annotations WHERE score_id = ?", (score_id,)
        ).fetchall()

    doc = fitz.open(pdf_path)  # 원본은 건드리지 않고 새로 연 사본에만 그림
    try:
        for arow in annot_rows:
            idx = arow["page_number"] - 1
            if 0 <= idx < doc.page_count:
                _draw_strokes(doc[idx], json.loads(arow["strokes_json"]))
        pdf_bytes = doc.tobytes(garbage=4, deflate=True)
    finally:
        doc.close()

    return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf",
                             headers={"Content-Disposition": content_disposition(f"{row['title']}.pdf")})


# ═══════════════════════════════════════════════════════════════
#   페이지 단위 조 변환 연동 (기존 /analyze 파이프라인 재사용)
# ═══════════════════════════════════════════════════════════════

@router.post("/scores/{score_id}/analyze-page/{page_number}")
async def analyze_page(score_id: int, page_number: int):
    get_score_row(score_id)
    pdf_path = _pdf_path(score_id)
    if not os.path.isfile(pdf_path):
        raise HTTPException(404, "PDF 파일을 찾을 수 없습니다")

    doc = fitz.open(pdf_path)
    try:
        if page_number < 1 or page_number > doc.page_count:
            raise HTTPException(400, "페이지 번호가 범위를 벗어났습니다")
        img = render_page_image(doc, page_number - 1)
    finally:
        doc.close()

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    image_bytes = buf.getvalue()

    # app.py의 기존 분석 함수를 그대로 재사용 (지연 임포트로 순환참조 회피)
    from app import OMR_AVAILABLE, analyze_with_ai, analyze_with_omr, get_demo_data

    omr_result = None
    if OMR_AVAILABLE:
        try:
            omr_result = analyze_with_omr(image_bytes)
        except Exception as e:
            logger.warning(f"OMR 분석 실패: {e}")

    try:
        ai_result = await analyze_with_ai(image_bytes, "image/png")
    except Exception as e:
        logger.warning(f"AI 분석 실패: {e}")
        ai_result = None

    if ai_result and ai_result.get("success"):
        result = ai_result
    elif omr_result and omr_result.get("success"):
        result = {
            "success": True,
            "key": "C",
            "scale": "Major",
            "key_display": "C Major",
            "time_signature": "4/4",
            "tempo": 120,
            "clef": "treble",
            "notes": omr_result.get("notes", []),
            "raw_analysis": "OMR 엔진 분석 결과 (AI 분석 불가)",
            "confidence": omr_result.get("confidence", 0.5),
            "engine": "omr",
        }
    else:
        result = get_demo_data()

    if omr_result and omr_result.get("success"):
        result["omr"] = {
            "staffs": omr_result.get("staffs", []),
            "notes": omr_result.get("notes", []),
            "measures": omr_result.get("measures", 0),
            "annotated_image": omr_result.get("annotated_image", ""),
            "detection_summary": omr_result.get("detection_summary", {}),
            "confidence": omr_result.get("confidence", 0),
        }

    return JSONResponse(result)
