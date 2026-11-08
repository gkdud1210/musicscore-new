"""
맥 서버(~/ChanyangServer)의 콘티·곡·즐겨찾기·필기를 카페24로 옮길 꾸러미로 만든다.

  /usr/bin/python3 cafe24/tools/export_from_mac.py [출력 폴더]

출력 폴더/data/ 아래에
  scores/<콘티 번호>/p<쪽>.jpg, thumb.jpg   ← 페이지 그림 (폭 1400px)
  import.json                               ← DB 내용
이 생긴다. data/ 를 카페24 www/data/ 에 올린 뒤 tools/import.sh 로 넣는다.
"""

import json
import os
import sqlite3
import sys

import fitz
from PIL import Image

SERVER = os.path.expanduser("~/ChanyangServer/backend/storage")
PAGE_WIDTH = 1400
THUMB_WIDTH = 300


def render(page, width, path, quality):
    z = width / max(page.rect.width, 1)
    if page.rect.height * z > 4000:
        z = 4000 / page.rect.height
    pix = page.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csRGB, alpha=False)
    Image.frombytes("RGB", (pix.width, pix.height), pix.samples).save(path, "JPEG", quality=quality)


def main():
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "cafe24_export")
    data_dir = os.path.join(out, "data")
    os.makedirs(os.path.join(data_dir, "scores"), exist_ok=True)
    conn = sqlite3.connect(f"file:{SERVER}/library.db?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = lambda sql, *a: [dict(r) for r in conn.execute(sql, a)]

    bundle = {"scores": [], "pages": [], "songs": [], "annotations": [], "marks": []}
    ocr = {(r["score_id"], r["page_number"]): r for r in rows("SELECT * FROM pages")}
    for s in rows("SELECT * FROM scores ORDER BY id"):
        sid = s["id"]
        pdf_path = os.path.join(SERVER, "scores", str(sid), "original.pdf")
        if not os.path.isfile(pdf_path):
            print(f"  ⚠️ [{sid}] PDF 없음 — 건너뜀")
            continue
        chords = [r["chord"] for r in rows("SELECT chord FROM score_chords WHERE score_id = ? ORDER BY chord", sid)]
        status = s.get("status") or "ready"
        bundle["scores"].append({
            "id": sid, "title": s["title"], "original_filename": s["original_filename"],
            "page_count": s["page_count"], "conti_date": s.get("conti_date"), "file_hash": s.get("file_hash"),
            "confirmed": s.get("confirmed", 1),
            "status": "error" if status == "processing" else status, "status_detail": s.get("status_detail") or "",
            "chords_text": " ".join(chords), "lyrics_text": s.get("lyrics_text") or "",
            "created_at": s["created_at"], "updated_at": s["updated_at"],
        })
        d = os.path.join(data_dir, "scores", str(sid))
        os.makedirs(d, exist_ok=True)
        doc = fitz.open(pdf_path)
        try:
            for i in range(doc.page_count):
                n = i + 1
                page = doc[i]
                img = os.path.join(d, f"p{n}.jpg")
                if not os.path.isfile(img):
                    render(page, PAGE_WIDTH, img, 85)
                if n == 1:
                    render(page, THUMB_WIDTH, os.path.join(d, "thumb.jpg"), 80)
                o = ocr.get((sid, n))
                bundle["pages"].append({
                    "score_id": sid, "page_number": n,
                    "width": round(page.rect.width, 3), "height": round(page.rect.height, 3),
                    "analyzed": 1 if o else 0,
                    "title_guess": o["title_guess"] if o else None,
                    "has_title": o["has_title"] if o else 0,
                    "key_explicit": (o["key_explicit"] or "") if o else "",
                    "chords_json": o["chords_json"] if o else "[]",
                    "lyrics_text": (o["lyrics_text"] or "") if o else "",
                })
        finally:
            doc.close()
        print(f"  ✓ [{sid}] {s['title']} ({s['page_count']}쪽)")

    keep = {s["id"] for s in bundle["scores"]}
    cols = ["id", "score_id", "page_start", "page_end", "title", "song_key", "key_source", "title_manual",
            "lyrics_text", "chords_text", "section", "tempo", "matched_from", "use_song_id", "created_at"]
    for so in rows("SELECT * FROM songs ORDER BY id"):
        if so["score_id"] in keep:
            bundle["songs"].append({c: so.get(c) for c in cols})
    for a in rows("SELECT * FROM annotations"):
        if a["score_id"] in keep:
            bundle["annotations"].append({k: a[k] for k in ("score_id", "page_number", "strokes_json", "updated_at")})
    try:
        bundle["marks"] = rows("SELECT group_key, mark, created_at FROM song_marks")
    except sqlite3.OperationalError:
        pass

    with open(os.path.join(data_dir, "import.json"), "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False)
    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(data_dir) for fn in fns)
    print(f"✅ 콘티 {len(bundle['scores'])}개, 페이지 {len(bundle['pages'])}쪽, 곡 {len(bundle['songs'])}개, "
          f"필기 {len(bundle['annotations'])}쪽, 즐겨찾기 {len(bundle['marks'])}개 → {data_dir} ({size / 1e6:.0f}MB)")


if __name__ == "__main__":
    main()
