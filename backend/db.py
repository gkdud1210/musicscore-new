"""
악보 라이브러리 데이터베이스
stdlib sqlite3 기반 — ORM 없이 얇은 접근 계층

모델:
- scores  : 업로드한 PDF 1개 = 콘티 1개 (기존 테이블 이름 유지)
- pages   : 콘티의 페이지별 OCR 결과 (제목 후보, 키 표기, 코드 순서, 가사)
- songs   : 콘티 안의 곡 1개 = 연속된 페이지 범위 + 제목/키/가사 (검색 단위)
"""

import os
import sqlite3

STORAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage")
SCORES_DIR = os.path.join(STORAGE_DIR, "scores")
DB_PATH = os.path.join(STORAGE_DIR, "library.db")


class _ClosingConnection(sqlite3.Connection):
    """`with get_conn() as conn:` 블록이 끝나면 커밋/롤백 후 연결까지 닫는다.
    (기본 sqlite3 연결은 with가 끝나도 닫히지 않아 연결이 계속 쌓인다)"""
    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def get_conn() -> sqlite3.Connection:
    """요청마다 새로 여는 연결. sqlite3 커넥션은 스레드 간 공유가 안전하지 않고,
    FastAPI의 동기 핸들러는 스레드풀에서 돌기 때문에 매번 새로 연다."""
    os.makedirs(STORAGE_DIR, exist_ok=True)
    # 다른 요청이 쓰는 중이면 최대 30초까지 기다린다
    conn = sqlite3.connect(DB_PATH, timeout=30, factory=_ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _add_column_if_missing(conn, table: str, column: str, ddl: str):
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def init_db():
    os.makedirs(SCORES_DIR, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                original_filename TEXT,
                page_count INTEGER NOT NULL DEFAULT 0,
                lyrics_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS score_chords (
                score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
                chord TEXT NOT NULL,
                PRIMARY KEY (score_id, chord)
            );
            CREATE INDEX IF NOT EXISTS idx_score_chords_chord ON score_chords(chord);

            CREATE TABLE IF NOT EXISTS annotations (
                score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL,
                strokes_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (score_id, page_number)
            );

            CREATE TABLE IF NOT EXISTS pages (
                score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL,
                title_guess TEXT,
                has_title INTEGER NOT NULL DEFAULT 0,
                key_explicit TEXT,
                chords_json TEXT NOT NULL DEFAULT '[]',
                lyrics_text TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (score_id, page_number)
            );

            CREATE TABLE IF NOT EXISTS songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
                page_start INTEGER NOT NULL,
                page_end INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '제목 없음',
                song_key TEXT NOT NULL DEFAULT '',
                key_source TEXT NOT NULL DEFAULT '',   -- explicit | inferred | manual | ''
                title_manual INTEGER NOT NULL DEFAULT 0,
                lyrics_text TEXT NOT NULL DEFAULT '',
                chords_text TEXT NOT NULL DEFAULT '',  -- 공백 구분 코드 목록 (중복 제거)
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_songs_score ON songs(score_id, page_start);
            CREATE INDEX IF NOT EXISTS idx_songs_key ON songs(song_key);
            """
        )
        _add_column_if_missing(conn, "scores", "conti_date", "conti_date TEXT")
        _add_column_if_missing(conn, "scores", "file_hash", "file_hash TEXT")


def score_dir(score_id: int) -> str:
    d = os.path.join(SCORES_DIR, str(score_id))
    os.makedirs(d, exist_ok=True)
    return d
