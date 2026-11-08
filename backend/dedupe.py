"""
같은 악보 / 겹치는 콘티 찾기

콘티마다 같은 곡 악보가 자주 다시 들어간다. 페이지 그림의 "지문"(dHash 32x32 = 1024비트)을
저장해 두고 서로 비교한다.
- 같은 PDF에서 나온 같은 페이지는 다른 비트가 0~25개
- 같은 곡이라도 다른 편곡/다른 키 악보는 50~200개, 다른 곡끼리는 280개 이상
  (실제 업로드된 콘티 199쪽으로 확인) → 48개 이하만 "같은 악보"로 본다.

쓰는 곳:
1) 곡 찾기에서 같은 악보는 카드 하나로 묶고, 제목·키·빠르기를 고치면 같은 악보 전부에 반영
2) 새 콘티를 올리면 이미 확인한 악보 페이지는 OCR 없이 그 결과(제목·키·곡 나누기)를 그대로 가져옴
3) 콘티끼리 겹치는지(똑같음 / 다른 콘티에 통째로 들어있음 / 절반 이상 겹침) 알려줌
"""

import logging
import os
from typing import Dict, List, Optional, Tuple

import fitz
from PIL import Image, ImageOps

logger = logging.getLogger("scoreshift.dedupe")

HASH_N = 32
MATCH_BITS = 48
_CHUNKS = 64                    # 1024비트를 16비트씩 64조각 → 48개 이하로 다르면 적어도 16조각은 똑같다
_CHUNK_BITS = HASH_N * HASH_N // _CHUNKS
_RENDER_WIDTH = 300


def init_dedupe_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS page_hashes (
            score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL,
            h TEXT NOT NULL,
            PRIMARY KEY (score_id, page_number)
        );
    """)


# ── 지문 만들기 ──────────────────────────────────────────────
def page_hash(page) -> int:
    z = _RENDER_WIDTH / max(page.rect.width, 1)
    pix = page.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY)
    img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    # 여백 차이에 흔들리지 않게 흰 여백을 잘라낸다
    bbox = ImageOps.invert(img).point(lambda v: 255 if v > 40 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    g = img.resize((HASH_N + 1, HASH_N), Image.LANCZOS)
    px = list(g.getdata())
    bits = 0
    w = HASH_N + 1
    for r in range(HASH_N):
        row = r * w
        for c in range(HASH_N):
            bits = (bits << 1) | (px[row + c] > px[row + c + 1])
    return bits


def compute_hashes(doc) -> List[int]:
    return [page_hash(doc[i]) for i in range(doc.page_count)]


def save_hashes(conn, score_id: int, hashes: List[int]):
    conn.execute("DELETE FROM page_hashes WHERE score_id = ?", (score_id,))
    conn.executemany("INSERT INTO page_hashes (score_id, page_number, h) VALUES (?, ?, ?)",
                     [(score_id, i + 1, format(h, "x")) for i, h in enumerate(hashes)])


def dist(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def same(a: int, b: int) -> bool:
    return dist(a, b) <= MATCH_BITS


def backfill_missing(get_conn, pdf_path):
    """지문이 없는 콘티(이 기능 전에 올린 것)의 지문을 만든다. 서버 시작 때 백그라운드로."""
    with get_conn() as conn:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM scores WHERE id NOT IN (SELECT DISTINCT score_id FROM page_hashes)")]
    for sid in ids:
        path = pdf_path(sid)
        if not os.path.isfile(path):
            continue
        try:
            doc = fitz.open(path)
            try:
                hashes = compute_hashes(doc)
            finally:
                doc.close()
            with get_conn() as conn:
                save_hashes(conn, sid, hashes)
                conn.commit()
        except Exception as e:
            logger.warning(f"[{sid}] 페이지 지문 만들기 실패: {e}")
    if ids:
        logger.info(f"🔎 페이지 지문 {len(ids)}개 콘티 만듦")


# ── 비교 결과 (DB가 바뀔 때만 다시 계산) ─────────────────────
_cache: dict = {"sig": None, "data": None}


def _signature(conn):
    return tuple(conn.execute("""SELECT
        (SELECT COUNT(*) FROM page_hashes), (SELECT COALESCE(SUM(score_id * 1000 + page_number), 0) FROM page_hashes),
        (SELECT COUNT(*) FROM songs), (SELECT COALESCE(SUM(id * 7 + page_start * 31 + page_end), 0) FROM songs),
        (SELECT COUNT(*) FROM scores)""").fetchone())


def _candidate_pairs(keys: List[Tuple[int, int]], hashes: Dict[Tuple[int, int], int]):
    buckets: Dict[Tuple[int, int], list] = {}
    mask = (1 << _CHUNK_BITS) - 1
    for k in keys:
        h = hashes[k]
        for c in range(_CHUNKS):
            buckets.setdefault((c, (h >> (c * _CHUNK_BITS)) & mask), []).append(k)
    seen = set()
    for members in buckets.values():
        if len(members) < 2:
            continue
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                pair = (members[i], members[j])
                if pair not in seen:
                    seen.add(pair)
                    yield pair


def index(conn) -> dict:
    sig = _signature(conn)
    if _cache["sig"] == sig:
        return _cache["data"]

    hashes = {(r["score_id"], r["page_number"]): int(r["h"], 16)
              for r in conn.execute("SELECT score_id, page_number, h FROM page_hashes")}
    keys = sorted(hashes)
    parent = {k: k for k in keys}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    for a, b in _candidate_pairs(keys, hashes):
        if same(hashes[a], hashes[b]):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
    cluster = {k: find(k) for k in keys}

    # 곡 → 악보 묶음: 첫 페이지가 같은 악보면 같은 묶음 (묶음 번호 = 가장 작은 곡 id)
    songs = conn.execute("SELECT id, score_id, page_start FROM songs ORDER BY id").fetchall()
    sheet_root: Dict = {}
    sheet_of: Dict[int, int] = {}
    for s in songs:
        c = cluster.get((s["score_id"], s["page_start"]))
        if c is None:
            sheet_of[s["id"]] = s["id"]
            continue
        sheet_root.setdefault(c, s["id"])
        sheet_of[s["id"]] = sheet_root[c]
    members: Dict[int, List[int]] = {}
    for sid, root in sheet_of.items():
        members.setdefault(root, []).append(sid)

    # 콘티끼리 겹침
    pages_of: Dict[int, set] = {}
    for (sid, _p), c in cluster.items():
        pages_of.setdefault(sid, set()).add(c)
    holders: Dict = {}
    for sid, cs in pages_of.items():
        for c in cs:
            holders.setdefault(c, set()).add(sid)
    shared: Dict[Tuple[int, int], int] = {}
    for c, sids in holders.items():
        for a in sids:
            for b in sids:
                if a != b:
                    shared[(a, b)] = shared.get((a, b), 0) + 1
    overlaps: Dict[int, list] = {}
    for (a, b), n in shared.items():
        na, nb = len(pages_of[a]), len(pages_of[b])
        if pages_of[a] == pages_of[b]:
            kind = "same"
        elif n == na:
            kind = "inside"      # a 가 b 안에 통째로 들어있음
        elif n == nb:
            kind = "contains"    # a 가 b 를 통째로 포함
        elif n * 2 >= na:
            kind = "partial"
        else:
            continue
        overlaps.setdefault(a, []).append({"id": b, "shared": n, "kind": kind})
    order = {"same": 0, "inside": 1, "contains": 2, "partial": 3}
    for v in overlaps.values():
        v.sort(key=lambda o: (order[o["kind"]], -o["shared"]))

    data = {"hashes": hashes, "cluster": cluster, "sheet_of": sheet_of, "members": members, "overlaps": overlaps}
    _cache.update(sig=sig, data=data)
    return data


def same_sheet_song_ids(conn, song_id: int) -> List[int]:
    idx = index(conn)
    root = idx["sheet_of"].get(song_id, song_id)
    return idx["members"].get(root, [song_id])


# ── 새로 올린 콘티: 이미 있는 악보 결과 재사용 ──────────────
def _ref_pages(conn, score_id: int):
    """다른 콘티(확인된 것 먼저)의 분석된 페이지 지문 목록."""
    return conn.execute("""
        SELECT ph.score_id, ph.page_number, ph.h, sc.confirmed
        FROM page_hashes ph JOIN scores sc ON sc.id = ph.score_id
        JOIN pages p ON p.score_id = ph.score_id AND p.page_number = ph.page_number
        WHERE ph.score_id != ? AND sc.status != 'processing'
        ORDER BY sc.confirmed DESC, ph.score_id DESC""", (score_id,)).fetchall()


def reference_pages(conn, score_id: int, hashes: List[int]) -> Dict[int, Tuple[int, int]]:
    """새 콘티의 페이지 번호 → 같은 그림인 기존 페이지 (score_id, page_number)."""
    refs = [(r["score_id"], r["page_number"], int(r["h"], 16)) for r in _ref_pages(conn, score_id)]
    out = {}
    for i, h in enumerate(hashes):
        best = None
        for sid, pn, rh in refs:       # 확인된 콘티 먼저 정렬돼 있으니 가장 가까운 것 중 앞쪽
            d = dist(h, rh)
            if d <= MATCH_BITS and (best is None or d < best[0]):
                best = (d, sid, pn)
                if d == 0:
                    break
        if best:
            out[i + 1] = (best[1], best[2])
    return out


def reference_songs(conn, score_id: int, hashes: List[int]) -> List[tuple]:
    """새 콘티에서 확인된 콘티의 곡과 페이지가 순서대로 똑같은 구간 → (시작, 끝, 원래 곡 row).
    이 구간은 원래 곡의 곡 나누기·제목·키·빠르기를 그대로 쓴다."""
    cands = conn.execute("""
        SELECT so.*, sc.confirmed FROM songs so JOIN scores sc ON sc.id = so.score_id
        WHERE so.score_id != ? AND sc.confirmed = 1 AND sc.status != 'processing'""", (score_id,)).fetchall()
    if not cands:
        return []
    ph = {}
    for r in conn.execute("SELECT score_id, page_number, h FROM page_hashes WHERE score_id IN "
                          "(SELECT id FROM scores WHERE confirmed = 1)"):
        ph[(r["score_id"], r["page_number"])] = int(r["h"], 16)
    cands = sorted(cands, key=lambda s: (-s["title_manual"], -(s["page_end"] - s["page_start"]), -s["id"]))
    out = []
    n = len(hashes)
    i = 1
    while i <= n:
        hit = None
        for s in cands:
            length = s["page_end"] - s["page_start"] + 1
            if i + length - 1 > n:
                continue
            ok = True
            for k in range(length):
                rh = ph.get((s["score_id"], s["page_start"] + k))
                if rh is None or not same(hashes[i - 1 + k], rh):
                    ok = False
                    break
            if ok:
                hit = (i, i + length - 1, s)
                break
        if hit:
            out.append(hit)
            i = hit[1] + 1
        else:
            i += 1
    return out


def merge_segments(ocr_segments: List[Tuple[int, int]], forced: List[tuple]) -> List[tuple]:
    """OCR로 나눈 곡 구간에 '기존 악보와 같은 구간'을 덮어쓴다. → [(시작, 끝, 원래 곡 row 또는 None)]"""
    covered = set()
    for a, b, _s in forced:
        covered.update(range(a, b + 1))
    out = list(forced)
    for a, b in ocr_segments:
        run = None
        for p in range(a, b + 1):
            if p in covered:
                if run:
                    out.append((run[0], run[1], None))
                    run = None
            else:
                run = (run[0], p) if run else (p, p)
        if run:
            out.append((run[0], run[1], None))
    return sorted(out, key=lambda t: t[0])


def overlaps_for(conn, score_id: int) -> list:
    return index(conn)["overlaps"].get(score_id, [])


def sheet_id(conn, song_id: int) -> Optional[int]:
    return index(conn)["sheet_of"].get(song_id, song_id)
