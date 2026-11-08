"""
즐겨찾기 표시(색깔 별·하트·동그라미·네모)와 라이브 모드(NOW).

- 표시: 곡 묶음(같은 제목) 단위로 팀 전체가 같이 보는 표시. 누구나 붙이고 뗄 수 있다.
- 라이브: 예배 중 한 사람이 콘티를 NOW로 보내면, 접속한 사람들이 몇 초 안에 알림을 받고
  OK를 누르면 그 콘티를 순서대로 넘겨 본다. 상태는 서버 메모리에만 둔다 (재시작하면 끝남).
"""

import threading
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_conn
from library import SONG_SELECT, _song_from_row

router = APIRouter()

MARKS = ["⭐", "❤️", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟥", "🟧", "🟨", "🟩", "🟦", "🟪"]


def init_extras_db():
    with get_conn() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS song_marks (
                   group_key TEXT NOT NULL,
                   mark TEXT NOT NULL,
                   created_at TEXT NOT NULL DEFAULT (datetime('now')),
                   PRIMARY KEY (group_key, mark)
               )"""
        )
        conn.commit()


# ── 즐겨찾기 표시 ────────────────────────────────────────────────

class MarkRequest(BaseModel):
    group_key: str
    marks: List[str]


@router.get("/marks")
def get_marks():
    with get_conn() as conn:
        rows = conn.execute("SELECT group_key, mark FROM song_marks ORDER BY created_at").fetchall()
    out: dict = {}
    for r in rows:
        out.setdefault(r["group_key"], []).append(r["mark"])
    return {"palette": MARKS, "marks": out}


@router.post("/marks")
def set_marks(req: MarkRequest):
    key = req.group_key.strip()
    if not key or len(key) > 200:
        raise HTTPException(400, "곡 정보가 잘못됐어요")
    marks = [m for m in dict.fromkeys(req.marks) if m in MARKS]
    with get_conn() as conn:
        conn.execute("DELETE FROM song_marks WHERE group_key = ?", (key,))
        conn.executemany("INSERT INTO song_marks (group_key, mark) VALUES (?, ?)", [(key, m) for m in marks])
        conn.commit()
    return {"group_key": key, "marks": marks}


# ── 라이브 모드 ──────────────────────────────────────────────────

LIVE_TTL_SECONDS = 6 * 3600
_live_lock = threading.Lock()
_live: Optional[dict] = None


class LiveRequest(BaseModel):
    title: str = ""
    song_ids: List[int]


def _current_live() -> Optional[dict]:
    global _live
    if _live and time.time() - _live["started_ts"] > LIVE_TTL_SECONDS:
        _live = None
    return _live


@router.get("/live")
def get_live():
    with _live_lock:
        return {"live": _current_live()}


@router.post("/live")
def start_live(req: LiveRequest):
    global _live
    ids = list(dict.fromkeys(req.song_ids))[:60]
    if not ids:
        raise HTTPException(400, "보낼 곡이 없어요")
    with get_conn() as conn:
        rows = {r["id"]: r for r in conn.execute(
            SONG_SELECT + f" WHERE so.id IN ({','.join('?' for _ in ids)})", ids).fetchall()}
    songs = [_song_from_row(rows[i]).model_dump() for i in ids if i in rows]
    if not songs:
        raise HTTPException(404, "곡을 찾을 수 없어요")
    now = time.time()
    with _live_lock:
        _live = {
            "id": int(now * 1000),  # 새로 보낼 때마다 바뀌는 번호 → 받는 쪽이 "새 알림"인지 구분
            "title": (req.title or "").strip()[:100] or "오늘 콘티",
            "songs": [{k: s[k] for k in ("id", "title", "key", "image_urls")} for s in songs],
            "started_ts": now,
            "started_at": time.strftime("%H:%M", time.localtime(now)),
        }
        return {"live": _live}


@router.delete("/live")
def stop_live():
    global _live
    with _live_lock:
        _live = None
    return {"live": None}
