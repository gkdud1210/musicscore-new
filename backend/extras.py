"""
즐겨찾기 표시(색깔 별·하트·동그라미·네모)와 라이브 모드(NOW).

- 표시: 곡 묶음(같은 제목) 단위로 팀 전체가 같이 보는 표시. 누구나 붙이고 뗄 수 있다.
- 라이브: 예배 중 한 사람이 콘티를 NOW로 보내면, 접속한 사람들이 몇 초 안에 알림을 받고
  OK를 누르면 그 콘티를 순서대로 넘겨 본다. 상태는 서버 메모리에만 둔다 (재시작하면 끝남).
"""

import json
import re
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
        # 예배 라이브 셋팅: 날짜마다 그날 볼 콘티들(순서대로)
        conn.execute(
            """CREATE TABLE IF NOT EXISTS services (
                   service_date TEXT PRIMARY KEY,
                   data TEXT NOT NULL,
                   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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


class LiveSet(BaseModel):
    title: str = ""
    song_ids: List[int] = []
    conti_id: Optional[int] = None


class LiveRequest(BaseModel):
    title: str = ""
    song_ids: List[int] = []
    sets: List[LiveSet] = []     # 예배 라이브: 여러 콘티를 위 메뉴에서 오가며 본다
    date: Optional[str] = None


def _current_live() -> Optional[dict]:
    global _live
    if _live and time.time() - _live["started_ts"] > LIVE_TTL_SECONDS:
        _live = None
    return _live


@router.get("/live")
def get_live():
    with _live_lock:
        return {"live": _current_live()}


def _songs_for(ids: List[int]) -> list:
    ids = list(dict.fromkeys(ids))[:80]
    if not ids:
        return []
    with get_conn() as conn:
        rows = {r["id"]: r for r in conn.execute(
            SONG_SELECT + f" WHERE so.id IN ({','.join('?' for _ in ids)})", ids).fetchall()}
    out = []
    for i in ids:
        if i in rows:
            s = _song_from_row(rows[i]).model_dump()
            out.append({k: s[k] for k in ("id", "title", "key", "image_urls")})
    return out


@router.post("/live")
def start_live(req: LiveRequest):
    global _live
    raw_sets = req.sets or [LiveSet(title=req.title, song_ids=req.song_ids)]
    sets = []
    for st in raw_sets[:12]:
        songs = _songs_for(st.song_ids)
        if songs:
            sets.append({"title": (st.title or "").strip()[:100] or "콘티", "conti_id": st.conti_id, "songs": songs})
    if not sets:
        raise HTTPException(400, "보낼 곡이 없어요")
    now = time.time()
    with _live_lock:
        _live = {
            "id": int(now * 1000),  # 새로 보낼 때마다 바뀌는 번호 → 받는 쪽이 "새 알림"인지 구분
            "title": (req.title or "").strip()[:100] or sets[0]["title"] or "오늘 콘티",
            "date": req.date,
            "sets": sets,
            "songs": [s for st in sets for s in st["songs"]],   # 예전 화면용 (한 줄로)
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


# ── 예배 라이브 셋팅 (날짜별) ────────────────────────────────────

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ServiceRequest(BaseModel):
    title: str = ""
    sets: List[LiveSet] = []


def _service_out(date: str, data: dict) -> dict:
    return {"date": date, "title": data.get("title", ""), "sets": data.get("sets", [])}


@router.get("/services")
def list_services():
    with get_conn() as conn:
        rows = conn.execute("SELECT service_date, data FROM services ORDER BY service_date DESC LIMIT 60").fetchall()
    return {"services": [_service_out(r["service_date"], json.loads(r["data"])) for r in rows]}


@router.get("/services/{date}")
def get_service(date: str):
    if not DATE_RE.match(date):
        raise HTTPException(400, "날짜 형식이 잘못됐어요")
    with get_conn() as conn:
        r = conn.execute("SELECT data FROM services WHERE service_date = ?", (date,)).fetchone()
    return {"service": _service_out(date, json.loads(r["data"])) if r else None}


@router.put("/services/{date}")
def put_service(date: str, req: ServiceRequest):
    if not DATE_RE.match(date):
        raise HTTPException(400, "날짜 형식이 잘못됐어요")
    data = {
        "title": req.title.strip()[:100],
        "sets": [{"title": (st.title or "").strip()[:100] or "콘티", "conti_id": st.conti_id,
                  "song_ids": list(dict.fromkeys(st.song_ids))[:80]} for st in req.sets[:12] if st.song_ids],
    }
    with get_conn() as conn:
        conn.execute("INSERT INTO services (service_date, data, updated_at) VALUES (?, ?, datetime('now'))"
                     " ON CONFLICT(service_date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                     (date, json.dumps(data, ensure_ascii=False)))
        conn.commit()
    return {"service": _service_out(date, data)}


@router.delete("/services/{date}")
def delete_service(date: str):
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE service_date = ?", (date,))
        conn.commit()
    return {"success": True}
