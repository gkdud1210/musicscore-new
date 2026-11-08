"""
악보 라이브러리 OCR / 분석 파이프라인

콘티 PDF 1개를 받아서:
  1) 페이지마다 텍스트 줄을 뽑는다 (PDF 텍스트 레이어가 있으면 그것을, 없으면 Tesseract OCR)
  2) 줄 단위로 제목 후보 / 키 표기 / 코드 줄 / 가사 줄을 구분한다
  3) 페이지들을 곡 단위로 묶는다 (제목이 새로 나오면 새 곡, 없거나 같으면 이어지는 페이지)
  4) 곡마다 키(조)를 정한다 — 악보에 "Key: G", "G코드", "사장조" 같은 표기가 있으면 그것을,
     없으면 코드 진행을 보고 추정한다 (다이어토닉 적합도 + 첫/끝 코드 가중치)

정확도 한계 (알려진 제약):
- 제목 추정은 "페이지 상단에서 눈에 띄게 큰 글자 줄" 휴리스틱이다. 손글씨/특이한 레이아웃은 틀릴 수 있다.
- 키 추정은 장조 기준이다. 단조 곡은 악보에 "Am" 같은 표기가 없으면 나란한 장조로 잡힌다.
- 그래서 UI에서 제목/키/곡 경계(합치기·나누기)를 언제든 고칠 수 있다.
"""

import logging
import re
import statistics
from difflib import SequenceMatcher

import fitz
from PIL import Image

try:   # 제미나이로 읽는 서버에는 Tesseract 가 없어도 된다
    import pytesseract
except ImportError:
    pytesseract = None

logger = logging.getLogger(__name__)

TESS_LANG = "kor+eng"
RENDER_ZOOM = 2.0          # 조 변환 등 기존 기능용 기본 배율
CHORD_OCR_WIDTH = 1800     # 코드 심볼 전용 OCR 폭(px) — 오선/음표 사이의 짧은 글자를 sparse 모드로 읽음
MIN_CHORD_CONF = 50
OCR_TARGET_WIDTH = 2400    # OCR용 렌더 폭(px). 작게 스캔된 PDF도 글자가 충분히 커지도록 배율을 페이지 크기에 맞춤
TITLE_REGION_RATIO = 0.30  # 페이지 상단 30% 안에서만 제목 후보를 찾음
TITLE_SIZE_RATIO = 1.3     # 제목 줄은 페이지 중간값 줄 높이보다 이만큼 커야 "제목"으로 본다
MIN_WORD_CONF = 30
MIN_TEXT_LAYER_CHARS = 80  # 텍스트 레이어가 이보다 짧으면 이미지 악보로 보고 OCR

CHORD_RE = re.compile(
    r'^[A-G](#|b|♯|♭)?'
    r'(maj7|maj9|maj|M7|min7|min9|min|m7b5|m7|m9|m6|m|dim7|dim|aug|°|ø'
    r'|sus2|sus4|sus|add9|add2|6|69|7|9|11|13)?'
    r'(\(?(b|#)?(5|9|11|13)\)?)?'
    r'(/[A-G](#|b|♯|♭)?)?$'
)
TOKEN_STRIP = "()[]{}|:.,'\"‘’“”-–—~"

NOTE_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
PC_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

KEY_TOKEN = r'([A-G](?:#|b|♯|♭)?m?)'
EXPLICIT_KEY_PATTERNS = [
    re.compile(r'(?i)\bkey\s*(?:of|in|[:=：\-])?\s*' + KEY_TOKEN + r'(?![a-ln-z])'),
    re.compile(r'(?<![A-Za-z])' + KEY_TOKEN + r'\s*(?:key|Key|KEY)\b'),
    re.compile(r'(?:원키|키|코드)\s*[:=：]?\s*' + KEY_TOKEN + r'(?![A-Za-z])'),
    re.compile(r'(?<![A-Za-z])' + KEY_TOKEN + r'\s*(?:코드|키)'),
]
LETTER_MODE_RE = re.compile(r'(?<![A-Za-z])([A-G](?:#|b|♯|♭)?)\s*(장조|단조)')
KOR_KEY_RE = re.compile(r'(내림|올림)?\s*(다|라|마|바|사|가|나)\s*(장조|단조)')
KOR_KEY_NAMES = {"다": "C", "라": "D", "마": "E", "바": "F", "사": "G", "가": "A", "나": "B"}
TITLE_PAREN_KEY_RE = re.compile(r'[\(\[]\s*' + KEY_TOKEN + r'\s*(?:key|Key|KEY)?\s*[\)\]]')

NON_TITLE_RE = re.compile(
    r'(작사|작곡|편곡|역사|번역|words|music|lyrics|arr\.|arranged|copyright|©|ccli|tempo|bpm|capo'
    r'|intro|verse|chorus|bridge|interlude|outro|ending|후렴|간주|전주|\bkey\b|=\s*\d{2,3})',
    re.I,
)


# ═══════════════════════════════════════════════════════════════
#   렌더링 / 썸네일
# ═══════════════════════════════════════════════════════════════

def render_page_image(doc: "fitz.Document", page_index: int, zoom: float = RENDER_ZOOM) -> Image.Image:
    page = doc[page_index]
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def generate_thumbnail(doc: "fitz.Document", out_path: str, zoom: float = 0.6):
    pix = doc[0].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    pix.save(out_path)  # PNG (확장자로 판단)


# ═══════════════════════════════════════════════════════════════
#   코드 / 키 유틸
# ═══════════════════════════════════════════════════════════════

def _safe_int(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return -1


def normalize_chord(token: str) -> str:
    token = token.replace('♯', '#').replace('♭', 'b')
    return token[0].upper() + token[1:]


def match_chord(token: str):
    token = (token or "").strip().strip(TOKEN_STRIP)
    if not token or len(token) > 10:
        return None
    if CHORD_RE.match(token):
        return normalize_chord(token)
    return None


def normalize_key(k: str) -> str:
    """'g', 'G♯', 'bbm' 같은 입력을 'G', 'G#', 'Bbm' 형태로."""
    k = (k or "").strip().replace('♯', '#').replace('♭', 'b')
    if not k:
        return ""
    m = re.match(r'^([A-Ga-g])(#|b)?(m|min|minor)?$', k)
    if not m:
        return k
    return m.group(1).upper() + (m.group(2) or "") + ("m" if m.group(3) else "")


def _chord_root_quality(chord: str):
    m = re.match(r'^([A-G])(#|b)?(.*)$', chord.split('/')[0])
    if not m:
        return None, None
    pc = NOTE_PC[m.group(1)]
    if m.group(2) == '#':
        pc = (pc + 1) % 12
    elif m.group(2) == 'b':
        pc = (pc - 1) % 12
    suffix = m.group(3)
    if suffix.startswith('maj') or suffix.startswith('M'):
        q = 'maj'
    elif suffix.startswith('m7b5') or suffix.startswith('dim') or suffix.startswith('°') or suffix.startswith('ø'):
        q = 'dim'
    elif suffix.startswith('m'):
        q = 'min'
    elif suffix.startswith('sus'):
        q = 'sus'
    else:
        q = 'maj'
    return pc, q


def _spelling_for_pc(pc: int, chords: list) -> str:
    for c in chords:
        root = re.match(r'^[A-G](#|b)?', c).group(0)
        rpc, _ = _chord_root_quality(root)
        if rpc == pc:
            return root
    return PC_NAMES[pc]


def infer_key_from_chords(chords: list) -> str:
    """코드 진행(순서 있는 목록)으로 장조 키를 추정. 코드가 없으면 ''."""
    parsed = [(c, *_chord_root_quality(c)) for c in chords]
    parsed = [p for p in parsed if p[1] is not None]
    if not parsed:
        return ""
    if len(parsed) < 3:
        c, pc, q = parsed[0]
        return _spelling_for_pc(pc, chords) + ("m" if q == 'min' else "")

    # 장조 다이어토닉: I ii iii IV V vi vii°
    degrees = [(0, 'maj'), (2, 'min'), (4, 'min'), (5, 'maj'), (7, 'maj'), (9, 'min'), (11, 'dim')]
    best_pc, best_score = 0, float('-inf')
    for k in range(12):
        expected = {(k + iv) % 12: q for iv, q in degrees}
        score = 0.0
        for _, pc, q in parsed:
            if pc in expected:
                exp_q = expected[pc]
                score += 1.0 if (q == exp_q or q == 'sus') else 0.3
            else:
                score -= 0.5
        # 딸림7화음(D7 등, maj7/m7 제외)은 그 키의 V7일 가능성이 높다
        for c, pc, q in parsed:
            if q == 'maj' and re.match(r'^[A-G](#|b)?7', c) and pc == (k + 7) % 12:
                score += 1.0
        _, first_pc, first_q = parsed[0]
        _, last_pc, last_q = parsed[-1]
        if first_pc == k and first_q in ('maj', 'sus'):
            score += 2.0
        if last_pc == k and last_q in ('maj', 'sus'):
            score += 1.0
        if score > best_score:
            best_pc, best_score = k, score
    return _spelling_for_pc(best_pc, chords)


def detect_explicit_key(text: str) -> str:
    """'Key: G', 'G코드', '사장조', 'D장조' 같은 키 표기를 찾는다."""
    if not text:
        return ""
    for pat in EXPLICIT_KEY_PATTERNS:
        m = pat.search(text)
        if m:
            return normalize_key(m.group(1))
    m = LETTER_MODE_RE.search(text)
    if m:
        return normalize_key(m.group(1)) + ("m" if m.group(2) == "단조" else "")
    m = KOR_KEY_RE.search(text)
    if m:
        root = KOR_KEY_NAMES[m.group(2)]
        if m.group(1) == "내림":
            root += "b"
        elif m.group(1) == "올림":
            root += "#"
        return root + ("m" if m.group(3) == "단조" else "")
    return ""


# ═══════════════════════════════════════════════════════════════
#   페이지 → 텍스트 줄
# ═══════════════════════════════════════════════════════════════

def _lines_from_text_layer(page: "fitz.Page") -> list:
    """PDF에 실제 텍스트가 들어있는 경우 (워드/한글/악보 프로그램에서 내보낸 PDF)."""
    ph = page.rect.height or 1
    out = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if (s.get("text") or "").strip()]
            if not spans:
                continue
            text = " ".join(s["text"].strip() for s in spans)
            x0, y0, x1, y1 = line["bbox"]
            out.append({
                "text": text,
                "top": y0 / ph,
                "size": max(s.get("size", 0) for s in spans) / ph,
                "left": x0,
            })
    out.sort(key=lambda l: (round(l["top"], 3), l["left"]))
    return out


def zoom_for_width(page: "fitz.Page", target_px: int) -> float:
    w = page.rect.width or 595
    return min(max(target_px / w, 1.0), 8.0)


def _lines_from_ocr(doc: "fitz.Document", page_index: int) -> list:
    img = render_page_image(doc, page_index, zoom=zoom_for_width(doc[page_index], OCR_TARGET_WIDTH))
    img = img.convert("L")
    if pytesseract is None:
        raise RuntimeError("이 서버에는 Tesseract가 없어요. backend/.env 에 GEMINI_API_KEY 를 넣어주세요")
    data = pytesseract.image_to_data(img, lang=TESS_LANG, output_type=pytesseract.Output.DICT)
    ih = img.height or 1
    lines = {}
    for j in range(len(data.get("text", []))):
        text = (data["text"][j] or "").strip()
        if not text or _safe_int(data["conf"][j]) < MIN_WORD_CONF:
            continue
        key = (data["block_num"][j], data["par_num"][j], data["line_num"][j])
        top, h, left = data["top"][j], data["height"][j], data["left"][j]
        line = lines.setdefault(key, {"words": [], "top": top, "bottom": top + h, "left": left, "heights": []})
        line["words"].append(text)
        line["heights"].append(h)
        line["top"] = min(line["top"], top)
        line["bottom"] = max(line["bottom"], top + h)
        line["left"] = min(line["left"], left)

    out = []
    for line in lines.values():
        out.append({
            "text": " ".join(line["words"]),
            "top": line["top"] / ih,
            # 줄 bbox 높이는 받침/기호 때문에 들쭉날쭉해서 단어 높이 중간값을 글자 크기로 사용
            "size": statistics.median(line["heights"]) / ih,
            "left": line["left"],
        })
    out.sort(key=lambda l: (round(l["top"], 3), l["left"]))
    return out


def _chords_sparse_ocr(doc: "fitz.Document", page_index: int) -> list:
    """오선 악보에서는 기본 레이아웃 분석이 코드 줄을 음표와 섞어버려서, 흩어진 글자를 찾는
    sparse 모드(psm 11)로 코드 심볼만 따로 읽는다. 읽는 순서(위→아래, 왼→오른)로 정렬."""
    img = render_page_image(doc, page_index, zoom=zoom_for_width(doc[page_index], CHORD_OCR_WIDTH)).convert("L")
    data = pytesseract.image_to_data(img, lang="eng", config="--psm 11", output_type=pytesseract.Output.DICT)
    found = []
    for j in range(len(data.get("text", []))):
        chord = match_chord(data["text"][j])
        if not chord:
            continue
        try:
            conf = float(data["conf"][j])
        except (TypeError, ValueError):
            conf = -1
        if conf < MIN_CHORD_CONF:
            continue
        found.append((data["top"][j], data["left"][j], data["height"][j], chord))
    if not found:
        return []
    row_h = max(statistics.median(f[2] for f in found), 1) * 1.5
    found.sort(key=lambda f: (int(f[0] // row_h), f[1]))
    return [f[3] for f in found]


def _chord_ratio(text: str):
    tokens = [t for t in text.split() if t.strip(TOKEN_STRIP)]
    if not tokens:
        return 0.0, []
    chords = [c for c in (match_chord(t) for t in tokens) if c]
    return len(chords) / len(tokens), chords


def _clean_title(text: str) -> str:
    t = TITLE_PAREN_KEY_RE.sub("", text)
    t = re.sub(r'(?i)\bkey\s*[:=：]?\s*[A-G](#|b)?m?\b', "", t)
    t = re.sub(r'^\s*(\d{1,2}\s*[.)\-]|\d{1,2}\s+(?=\D))', "", t)  # 앞 번호 "1." "01 "
    t = t.strip(" \t-–—·•♪♫|:.,")
    t = re.sub(r'\s+', ' ', t)
    # 한글 제목이면 앞뒤에 붙은 OCR 잡음(한글 없는 토큰: "eae", "ve", "an 68)")을 떼어낸다
    if len(re.findall(r'[가-힣]', t)) >= 2:
        tokens = t.split(' ')
        while tokens and not re.search(r'[가-힣]', tokens[0]):
            tokens.pop(0)
        while tokens and not re.search(r'[가-힣]', tokens[-1]):
            tokens.pop()
        t = ' '.join(tokens)
    # OCR이 한글을 한 글자씩 띄어 읽는 경우("예 배 자") 붙여준다
    t = re.sub(r'(?<![가-힣])([가-힣])((?: [가-힣](?![가-힣]))+)',
               lambda m: m.group(1) + m.group(2).replace(' ', ''), t)
    return t


def analyze_page(doc: "fitz.Document", page_index: int) -> dict:
    page = doc[page_index]
    lines = _lines_from_text_layer(page)
    used_ocr = False
    if sum(len(l["text"]) for l in lines) < MIN_TEXT_LAYER_CHARS:
        try:
            lines = _lines_from_ocr(doc, page_index)
            used_ocr = True
        except Exception as e:
            logger.warning(f"OCR 실패 (page {page_index + 1}): {e}")

    chords, lyric_lines, title_candidates = [], [], []
    for l in lines:
        ratio, line_chords = _chord_ratio(l["text"])
        l["is_chord_line"] = ratio >= 0.5
        if l["is_chord_line"]:
            chords.extend(line_chords)
            continue
        if l["top"] <= TITLE_REGION_RATIO and not NON_TITLE_RE.search(l["text"]):
            cleaned = _clean_title(l["text"])
            letters = re.sub(r'[^0-9A-Za-z가-힣]', '', cleaned)
            if len(letters) >= 2 and not letters.isdigit():
                title_candidates.append((l["size"], -l["top"], cleaned, l))
        words = [w for w in re.sub(r'[-–—~_]', ' ', l["text"]).split() if not match_chord(w)]
        if words:
            lyric_lines.append(" ".join(words))

    if used_ocr:
        try:
            sparse = _chords_sparse_ocr(doc, page_index)
            if len(sparse) >= len(chords):
                chords = sparse
        except Exception as e:
            logger.warning(f"코드 OCR 실패 (page {page_index + 1}): {e}")

    sizes = [l["size"] for l in lines if not l.get("is_chord_line")] or [l["size"] for l in lines]
    median_size = statistics.median(sizes) if sizes else 0

    title, has_title, title_line = None, False, None
    if title_candidates:
        title_candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
        size, _, title, title_line = title_candidates[0]
        has_title = median_size > 0 and size >= median_size * TITLE_SIZE_RATIO

    # 키 표기: 제목 줄 괄호 "(G)" → 상단부 → 페이지 전체 순으로 찾음
    key_explicit = ""
    if title_line:
        m = TITLE_PAREN_KEY_RE.search(title_line["text"])
        if m:
            key_explicit = normalize_key(m.group(1))
    if not key_explicit:
        top_text = "\n".join(l["text"] for l in lines if l["top"] <= 0.35)
        key_explicit = detect_explicit_key(top_text) or detect_explicit_key("\n".join(l["text"] for l in lines))

    if title_line is not None and lyric_lines:
        lyric_lines = [x for x in lyric_lines if x != " ".join(
            w for w in title_line["text"].split() if not match_chord(w))]

    return {
        "page_number": page_index + 1,
        "title_guess": title,
        "has_title": bool(has_title),
        "key_explicit": key_explicit,
        "chords": chords,
        "lyrics_text": "\n".join(lyric_lines),
    }


def analyze_pdf(doc: "fitz.Document") -> list:
    return [analyze_page(doc, i) for i in range(doc.page_count)]


# ═══════════════════════════════════════════════════════════════
#   곡 단위 분리 / 곡 메타데이터
# ═══════════════════════════════════════════════════════════════

def _norm_title(t: str) -> str:
    return re.sub(r'[^0-9a-z가-힣]', '', (t or "").lower())


def titles_similar(a: str, b: str) -> bool:
    na, nb = _norm_title(a), _norm_title(b)
    if not na or not nb:
        return False
    if na == nb or na in nb or nb in na:
        return True
    return SequenceMatcher(None, na, nb).ratio() >= 0.75


def segment_songs(pages: list) -> list:
    """페이지 분석 결과 → [(page_start, page_end), ...] (1-indexed, 양끝 포함).
    새 제목이 크게 보이면 새 곡, 제목이 없거나 직전 곡과 같으면 이어지는 페이지로 본다."""
    ranges = []
    current_title = None
    for p in pages:
        n = p["page_number"]
        starts_new = (
            not ranges
            or (p["has_title"] and not titles_similar(p["title_guess"], current_title))
        )
        if starts_new:
            ranges.append([n, n])
            current_title = p["title_guess"] if p["has_title"] else None
        else:
            ranges[-1][1] = n
    return [tuple(r) for r in ranges]


def build_song_meta(pages: list) -> dict:
    """곡에 속한 페이지들(순서대로)의 분석 결과로 곡 제목/키/가사/코드를 만든다."""
    first = pages[0]
    title = first.get("title_guess") or "제목 없음"
    all_chords = [c for p in pages for c in p.get("chords", [])]

    key, source = "", ""
    for p in pages:
        if p.get("key_explicit"):
            key, source = p["key_explicit"], "explicit"
            break
    if not key:
        key = infer_key_from_chords(all_chords)
        source = "inferred" if key else ""

    seen, uniq = set(), []
    for c in all_chords:
        if c not in seen:
            seen.add(c)
            uniq.append(c)

    return {
        "title": title,
        "song_key": key,
        "key_source": source,
        "lyrics_text": "\n".join(p.get("lyrics_text", "") for p in pages if p.get("lyrics_text")),
        "chords": uniq,
    }
