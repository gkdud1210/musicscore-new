"""
ScoreShift Backend — AI 악보 조 변환기
FastAPI + Claude Vision + music21 + OMR
"""

import os
import io
import base64
import json
import logging
import tempfile
from typing import Optional, List

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn

# ── 로깅 설정 ──────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

# ── 앱 생성 ───────────────────────────────────────────────────
app = FastAPI(
    title="ScoreShift API",
    description="AI 악보 분석 및 조 변환 서비스",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # 프로덕션에서는 실제 도메인으로 변경
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 환경 변수 로드 ─────────────────────────────────────────────
from dotenv import load_dotenv
load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# ── music21 임포트 (설치된 경우) ───────────────────────────────
try:
    from music21 import stream, note, key, pitch, interval, chord, converter, meter, tempo as m21tempo
    MUSIC21_AVAILABLE = True
    logger.info("✅ music21 사용 가능")
except ImportError:
    MUSIC21_AVAILABLE = False
    logger.warning("⚠️  music21 미설치 — 로컬 알고리즘으로 대체합니다")

# ── OMR 엔진 임포트 ───────────────────────────────────────────
try:
    from omr import analyze_with_omr
    OMR_AVAILABLE = True
    logger.info("✅ OMR 엔진 사용 가능 (OpenCV)")
except ImportError as e:
    OMR_AVAILABLE = False
    logger.warning(f"⚠️  OMR 엔진 미사용: {e}")

# ── 공용 비밀번호 로그인 (APP_PASSWORD / ADMIN_PASSWORD) ──────
from auth import auth_enabled, auth_middleware, router as auth_router

app.middleware("http")(auth_middleware)
app.include_router(auth_router, prefix="/api")
logger.info("🔒 비밀번호 로그인 사용" if auth_enabled() else "🔓 로그인 없이 사용 (APP_PASSWORD 미설정)")

# ── 악보 라이브러리 (PDF 업로드/OCR/필기) ─────────────────────
from db import init_db
from library import resume_pending_analysis, router as library_router

init_db()
app.include_router(library_router, prefix="/api")
resume_pending_analysis()

# ── 즐겨찾기 표시 / 라이브 모드(NOW) ─────────────────────────
from extras import init_extras_db, router as extras_router

init_extras_db()
app.include_router(extras_router, prefix="/api")
logger.info("✅ 악보 라이브러리 API 등록 (/api/scores)")

# ── Anthropic Claude 임포트 (설치된 경우) ─────────────────────
try:
    import anthropic
    AI_AVAILABLE = bool(ANTHROPIC_API_KEY)
    if AI_AVAILABLE:
        claude_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        logger.info("✅ Claude API 사용 가능")
    else:
        logger.warning("⚠️  ANTHROPIC_API_KEY 없음 — OMR/데모 모드로 대체합니다")
except ImportError:
    AI_AVAILABLE = False
    logger.warning("⚠️  anthropic 미설치")

# ═══════════════════════════════════════════════════════════════
#   Pydantic 모델
# ═══════════════════════════════════════════════════════════════

class NoteData(BaseModel):
    pitch: str = "C"
    octave: int = 4
    duration: str = "q"
    dotted: bool = False
    measure: int = 1
    beat: float = 1.0
    type: str = "note"        # "note" | "rest"
    accidental: Optional[str] = None
    original_pitch: Optional[str] = None
    original_octave: Optional[int] = None

class TransposeRequest(BaseModel):
    notes: List[NoteData]
    original_key: str = "C"
    target_key: str = "G"
    semitones: int = 7
    time_signature: str = "4/4"
    tempo: Optional[int] = 120
    maintain_octave: bool = True
    use_flats: bool = False

# ═══════════════════════════════════════════════════════════════
#   유틸리티
# ═══════════════════════════════════════════════════════════════

ALL_NOTES   = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
FLAT_NOTES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

FLAT_MAP = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#', 'Cb': 'B'}

def normalize_pitch(p: str) -> str:
    return FLAT_MAP.get(p, p)

def transpose_note_local(note_data: NoteData, semitones: int, use_flats: bool = False) -> NoteData:
    """로컬 알고리즘으로 음표 1개 조 변환"""
    if note_data.type == "rest":
        return note_data.copy()

    note_arr = FLAT_NOTES if use_flats else ALL_NOTES
    norm_pitch = normalize_pitch(note_data.pitch)
    original_idx = ALL_NOTES.index(norm_pitch) if norm_pitch in ALL_NOTES else 0

    total_semitones = note_data.octave * 12 + original_idx + semitones
    new_octave = total_semitones // 12
    new_idx    = total_semitones % 12

    # 옥타브 범위 제한 (0–8)
    new_octave = max(0, min(8, new_octave))
    new_pitch  = note_arr[new_idx]

    return NoteData(
        pitch=new_pitch,
        octave=new_octave,
        duration=note_data.duration,
        measure=note_data.measure,
        beat=note_data.beat,
        type=note_data.type,
        original_pitch=note_data.pitch,
        original_octave=note_data.octave,
    )

def transpose_with_music21(notes: list, semitones: int, use_flats: bool = False) -> list:
    """music21을 사용한 정확한 조 변환"""
    s = stream.Stream()
    for n in notes:
        if n["type"] == "rest":
            r = note.Rest(quarterLength=dur_to_ql(n["duration"]))
            s.append(r)
        else:
            p = pitch.Pitch(f"{n['pitch']}{n['octave']}")
            n_obj = note.Note(p, quarterLength=dur_to_ql(n["duration"]))
            s.append(n_obj)

    transposed = s.transpose(semitones)

    result = []
    orig_data = notes
    for i, element in enumerate(transposed.flat.notesAndRests):
        orig = orig_data[i] if i < len(orig_data) else {}
        if isinstance(element, note.Note):
            p = element.pitch
            pitch_str = p.step
            acc = None
            if p.accidental:
                if p.accidental.name == 'sharp': acc = '#'; pitch_str += '#'
                elif p.accidental.name == 'flat': acc = 'b'; pitch_str += 'b'
            result.append({
                "pitch": pitch_str,
                "octave": p.octave,
                "duration": ql_to_dur(element.quarterLength),
                "measure": orig.get("measure", 1),
                "beat": orig.get("beat", 1),
                "type": "note",
                "accidental": acc,
                "original_pitch": orig.get("pitch"),
                "original_octave": orig.get("octave"),
            })
        elif isinstance(element, note.Rest):
            result.append({
                "pitch": "B",
                "octave": 4,
                "duration": ql_to_dur(element.quarterLength),
                "measure": orig.get("measure", 1),
                "beat": orig.get("beat", 1),
                "type": "rest",
            })
    return result

def dur_to_ql(dur: str, dotted: bool = False) -> float:
    """duration 문자열 → quarterLength"""
    m = {'w': 4, 'whole': 4, '1': 4, 'h': 2, 'half': 2, '2': 2,
         'q': 1, 'quarter': 1, '4': 1, '8': 0.5, 'eighth': 0.5,
         '16': 0.25, 'sixteenth': 0.25, '32': 0.125}
    ql = m.get(str(dur), 1.0)
    if dotted:
        ql *= 1.5
    return ql

def ql_to_dur(ql: float) -> str:
    m = {4: 'w', 2: 'h', 1: 'q', 0.5: '8', 0.25: '16'}
    return m.get(ql, 'q')

# ═══════════════════════════════════════════════════════════════
#   MusicXML / MIDI 파싱 (music21 — API 불필요)
# ═══════════════════════════════════════════════════════════════

def analyze_with_music21(file_data: bytes, filename: str) -> dict:
    """music21로 MusicXML/MIDI 파일 파싱 — API 키 없이 로컬에서 완전 분석"""
    if not MUSIC21_AVAILABLE:
        raise Exception("music21이 설치되어 있지 않습니다")

    # 임시 파일로 저장 후 파싱
    suffix = os.path.splitext(filename)[1].lower()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_data)
        tmp_path = tmp.name

    try:
        score = converter.parse(tmp_path)
    finally:
        os.unlink(tmp_path)

    # ── 조성 추출 ──
    detected_key = score.analyze('key')
    key_name = detected_key.tonic.name if detected_key else "C"
    scale_name = detected_key.mode.capitalize() if detected_key else "Major"

    # ── 박자 추출 ──
    time_sig = "4/4"
    for el in score.recurse():
        if isinstance(el, meter.TimeSignature):
            time_sig = el.ratioString
            break

    # ── 템포 추출 ──
    tempo_val = 120
    for el in score.recurse():
        if isinstance(el, m21tempo.MetronomeMark):
            tempo_val = int(el.number)
            break

    # ── 음자리표 추출 ──
    clef_name = "treble"
    from music21 import clef as m21clef
    for el in score.recurse():
        if isinstance(el, m21clef.Clef):
            if isinstance(el, m21clef.BassClef):
                clef_name = "bass"
            elif isinstance(el, m21clef.AltoClef):
                clef_name = "alto"
            break

    # ── 음표 추출 ──
    notes_list = []
    for el in score.recurse().notesAndRests:
        if isinstance(el, note.Note):
            p = el.pitch
            pitch_str = p.step
            acc = None
            if p.accidental:
                if p.accidental.name == 'sharp':
                    acc = '#'
                    pitch_str += '#'
                elif p.accidental.name == 'flat':
                    acc = 'b'
                    pitch_str += 'b'
                elif p.accidental.name == 'double-sharp':
                    acc = '##'
                    pitch_str += '##'
                elif p.accidental.name == 'double-flat':
                    acc = 'bb'
                    pitch_str += 'bb'

            measure_num = el.measureNumber if el.measureNumber else 1
            beat_pos = float(el.beat) if hasattr(el, 'beat') else 1.0

            notes_list.append({
                "pitch": pitch_str,
                "octave": p.octave,
                "duration": ql_to_dur(el.quarterLength),
                "measure": measure_num,
                "beat": beat_pos,
                "type": "note",
                "accidental": acc,
            })
        elif isinstance(el, note.Rest):
            measure_num = el.measureNumber if el.measureNumber else 1
            beat_pos = float(el.beat) if hasattr(el, 'beat') else 1.0
            notes_list.append({
                "pitch": "B",
                "octave": 4,
                "duration": ql_to_dur(el.quarterLength),
                "measure": measure_num,
                "beat": beat_pos,
                "type": "rest",
            })
        elif isinstance(el, chord.Chord):
            measure_num = el.measureNumber if el.measureNumber else 1
            beat_pos = float(el.beat) if hasattr(el, 'beat') else 1.0
            for p in el.pitches:
                pitch_str = p.step
                acc = None
                if p.accidental:
                    if p.accidental.name == 'sharp':
                        acc = '#'
                        pitch_str += '#'
                    elif p.accidental.name == 'flat':
                        acc = 'b'
                        pitch_str += 'b'
                notes_list.append({
                    "pitch": pitch_str,
                    "octave": p.octave,
                    "duration": ql_to_dur(el.quarterLength),
                    "measure": measure_num,
                    "beat": beat_pos,
                    "type": "note",
                    "accidental": acc,
                })

    # 파트 정보
    parts_info = []
    for part in score.parts:
        parts_info.append(part.partName or "Part")

    raw = (
        f"music21 로컬 분석 완료 (API 불필요)\n"
        f"조성: {key_name} {scale_name}\n"
        f"박자: {time_sig}\n"
        f"템포: {tempo_val} BPM\n"
        f"음자리표: {clef_name}\n"
        f"총 음표/쉼표: {len(notes_list)}개\n"
        f"파트: {', '.join(parts_info) if parts_info else '1개'}"
    )

    return {
        "success": True,
        "key": key_name,
        "scale": scale_name,
        "key_display": f"{key_name} {scale_name}",
        "time_signature": time_sig,
        "tempo": tempo_val,
        "clef": clef_name,
        "notes": notes_list,
        "raw_analysis": raw,
        "confidence": 1.0,
        "engine": "music21",
    }

# ═══════════════════════════════════════════════════════════════
#   AI 악보 분석 (Claude Vision)
# ═══════════════════════════════════════════════════════════════

ANALYSIS_PROMPT = """당신은 세계 최고 수준의 음악 이론가이자 악보 판독 전문가입니다.
첨부된 악보 이미지를 아래의 단계별 절차에 따라 정밀하게 분석해주세요.

## 분석 단계 (반드시 순서대로 수행):

### 1단계: 기본 정보 확인
- **음자리표**: 높은음자리표(Treble Clef, 소용돌이 모양 G자) 또는 낮은음자리표(Bass Clef, F자 모양)
- **조표(Key Signature)**:
  * 샵(#) 개수: 0=C장조, 1=G장조, 2=D장조, 3=A장조, 4=E장조, 5=B장조, 6=F#장조, 7=C#장조
  * 플랫(♭) 개수: 1=F장조, 2=Bb장조, 3=Eb장조, 4=Ab장조, 5=Db장조, 6=Gb장조
  * 단조는 장조보다 단3도 낮음 (G장조 → E단조)
- **박자표**: 4/4, 3/4, 2/4, 6/8, 12/8 등 분수 형태

### 2단계: 마디 구분
- 세로 마디선(barline)을 기준으로 마디 번호 부여 (1부터 시작)
- 이중 세로선(double barline)도 마디선으로 처리

### 3단계: 오선 위치 → 음이름 변환

#### 높은음자리표(Treble Clef) 기준 - 아래에서 위 순서:
| 위치 | 음이름 | 계이름 |
|------|--------|--------|
| 첫째줄 아래 둘째 덧줄 | C4 | 도 |
| 첫째줄 아래 첫째 덧줄 | C4 | 도 (가운데 도) |
| 첫째줄 아래 덧줄 위 칸 | D4 | 레 |
| **첫째줄** | **E4** | **미** |
| 첫째칸 | F4 | 파 |
| **둘째줄** | **G4** | **솔** |
| 둘째칸 | A4 | 라 |
| **셋째줄** | **B4** | **시** |
| 셋째칸 | C5 | 도 |
| **넷째줄** | **D5** | **레** |
| 넷째칸 | E5 | 미 |
| **다섯째줄** | **F5** | **파** |
| 다섯째줄 위 첫째 칸 | G5 | 솔 |
| 다섯째줄 위 첫째 덧줄 | A5 | 라 |

#### 낮은음자리표(Bass Clef) 기준 - 아래에서 위 순서:
- 첫째줄: G2(솔), 첫째칸: A2(라)
- 둘째줄: B2(시), 둘째칸: C3(도)
- 셋째줄: D3(레), 셋째칸: E3(미)
- 넷째줄: F3(파), 넷째칸: G3(솔)
- 다섯째줄: A3(라)

### 4단계: 음표 모양 → 음길이 변환
| 모양 | 음길이 | 코드 |
|------|--------|------|
| 타원형, 속 빔, 줄기 없음 | 온음표 | "w" |
| 타원형, 속 빔, 줄기 있음 | 2분음표 | "h" |
| 타원형, 속 검정, 줄기 있음, 꼬리 없음 | 4분음표 | "q" |
| 타원형, 속 검정, 줄기 + 꼬리 1개 or 보 1줄 | 8분음표 | "8" |
| 타원형, 속 검정, 줄기 + 꼬리 2개 or 보 2줄 | 16분음표 | "16" |
| 타원형, 속 검정, 줄기 + 꼬리 3개 or 보 3줄 | 32분음표 | "32" |
- **점음표**: 음표 오른쪽에 점(·) → "dotted": true (원래 길이의 1.5배)

### 5단계: 쉼표 판독
- 온쉼표(whole rest): 넷째줄 아래 매달린 직사각형
- 2분쉼표(half rest): 셋째줄 위에 놓인 직사각형
- 4분쉼표(quarter rest): 지그재그 모양 기호
- 8분쉼표(eighth rest): 7자 혹은 구불구불한 기호
- type을 "rest"로, pitch는 "B", octave는 4로 설정

### 6단계: 임시표(Accidentals) 확인
- 음표 바로 왼쪽에 위치
- "#": 올림표 (반음 올림)
- "b": 내림표 (반음 내림)
- "n" or "♮": 제자리표 (조표 취소)

### 7단계: 박자 위치(beat) 계산
박자표에 따라 각 음표의 마디 내 박자 위치 계산:
- 첫 음표는 항상 beat=1.0
- 4분음표=1박, 2분음표=2박, 온음표=4박, 8분음표=0.5박, 16분음표=0.25박
- 점음표면 1.5배 (점4분=1.5박, 점8분=0.75박)

## 출력 형식 (JSON만, 다른 텍스트 절대 없이):
{
  "key": "C",
  "scale": "Major",
  "time_signature": "4/4",
  "tempo": 120,
  "clef": "treble",
  "notes": [
    {
      "pitch": "C",
      "octave": 4,
      "duration": "q",
      "dotted": false,
      "measure": 1,
      "beat": 1.0,
      "type": "note",
      "accidental": null
    }
  ],
  "raw_analysis": "악보 전체에 대한 상세한 분석 설명 (조성, 박자, 각 마디 내용 포함)",
  "confidence": 0.95
}

## 최종 규칙:
- key: C, G, D, A, E, B, F#, C#, F, Bb, Eb, Ab, Db, Gb, Cb 중 하나
- scale: "Major" 또는 "Minor"
- clef: "treble" 또는 "bass"
- duration: "w", "h", "q", "8", "16", "32" 중 하나
- dotted: true 또는 false (기본값 false)
- octave: 국제 표준 옥타브 번호 (가운데 C = C4)
- accidental: null, "#", "b", "n" 중 하나
- type: "note" 또는 "rest"
- **모든 음표와 쉼표를 왼→오른쪽, 위→아래 오선 순서로 빠짐없이 기록**
- **각 마디의 박자 합계가 박자표와 일치하는지 최종 검증**
- confidence: 분석의 전반적 신뢰도 0.0~1.0"""

async def analyze_with_ai(image_data: bytes, mime_type: str) -> dict:
    """Claude Vision으로 악보 분석"""
    if not AI_AVAILABLE:
        return get_demo_data()

    b64 = base64.b64encode(image_data).decode('utf-8')

    # mime_type 정리
    media_type = mime_type
    if media_type not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        media_type = "image/png"

    try:
        response = claude_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4000,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": ANALYSIS_PROMPT},
                ],
            }],
        )
        raw_text = response.content[0].text.strip()
        logger.info(f"Claude 응답 수신 ({len(raw_text)} chars)")

        # JSON 파싱
        if "```json" in raw_text:
            raw_text = raw_text.split("```json")[1].split("```")[0].strip()
        elif "```" in raw_text:
            raw_text = raw_text.split("```")[1].split("```")[0].strip()

        parsed = json.loads(raw_text)
        parsed["success"] = True
        parsed["key_display"] = f"{parsed.get('key', 'C')} {parsed.get('scale', 'Major')}"
        parsed["engine"] = "claude"
        return parsed

    except json.JSONDecodeError as e:
        logger.error(f"JSON 파싱 오류: {e}")
        return {**get_demo_data(), "raw_analysis": f"JSON 파싱 오류: {raw_text[:500]}"}
    except Exception as e:
        logger.error(f"Claude API 오류: {e}")
        raise

def get_demo_data() -> dict:
    """데모용 기본 데이터"""
    return {
        "success": True,
        "key": "C",
        "scale": "Major",
        "key_display": "C Major",
        "time_signature": "4/4",
        "tempo": 120,
        "clef": "treble",
        "notes": [
            {"pitch": "C", "octave": 4, "duration": "q", "measure": 1, "beat": 1.0, "type": "note"},
            {"pitch": "E", "octave": 4, "duration": "q", "measure": 1, "beat": 2.0, "type": "note"},
            {"pitch": "G", "octave": 4, "duration": "q", "measure": 1, "beat": 3.0, "type": "note"},
            {"pitch": "C", "octave": 5, "duration": "q", "measure": 1, "beat": 4.0, "type": "note"},
            {"pitch": "D", "octave": 5, "duration": "h", "measure": 2, "beat": 1.0, "type": "note"},
            {"pitch": "B", "octave": 4, "duration": "q", "measure": 2, "beat": 3.0, "type": "note"},
            {"pitch": "G", "octave": 4, "duration": "q", "measure": 2, "beat": 4.0, "type": "note"},
            {"pitch": "A", "octave": 4, "duration": "q", "measure": 3, "beat": 1.0, "type": "note"},
            {"pitch": "F", "octave": 4, "duration": "q", "measure": 3, "beat": 2.0, "type": "note"},
            {"pitch": "G", "octave": 4, "duration": "h", "measure": 3, "beat": 3.0, "type": "note"},
            {"pitch": "E", "octave": 4, "duration": "q", "measure": 4, "beat": 1.0, "type": "note"},
            {"pitch": "D", "octave": 4, "duration": "q", "measure": 4, "beat": 2.0, "type": "note"},
            {"pitch": "C", "octave": 4, "duration": "h", "measure": 4, "beat": 3.0, "type": "note"},
        ],
        "raw_analysis": "데모 모드: Anthropic API 키가 없어 샘플 데이터를 사용합니다.\n.env 파일에 ANTHROPIC_API_KEY를 설정하면 Claude AI 분석이 가능합니다.",
        "confidence": 1.0,
    }

# ═══════════════════════════════════════════════════════════════
#   API 엔드포인트
# ═══════════════════════════════════════════════════════════════

@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "ai": AI_AVAILABLE,
        "music21": MUSIC21_AVAILABLE,
        "omr": OMR_AVAILABLE,
        "version": "1.1.0",
    }

MUSIC_FILE_EXTENSIONS = {'.xml', '.musicxml', '.mxl', '.mid', '.midi', '.krn', '.abc'}
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"}

@app.post("/analyze")
async def analyze_score(file: UploadFile = File(...)):
    """악보 파일 분석 — MusicXML/MIDI는 로컬 파싱, 이미지는 AI 분석"""
    logger.info(f"📤 분석 요청: {file.filename} ({file.content_type})")

    contents = await file.read()
    if len(contents) > 20 * 1024 * 1024:
        raise HTTPException(400, "파일 크기가 20MB를 초과합니다")

    # 파일 확장자로 타입 판별
    ext = os.path.splitext(file.filename or "")[1].lower()

    try:
        # MusicXML / MIDI / ABC / Kern → music21 로컬 파싱
        if ext in MUSIC_FILE_EXTENSIONS:
            if not MUSIC21_AVAILABLE:
                raise HTTPException(500, "music21이 설치되어 있지 않아 악보 파일을 파싱할 수 없습니다")
            logger.info(f"🎼 music21 로컬 파싱: {file.filename}")
            result = analyze_with_music21(contents, file.filename)
            logger.info(f"✅ 파싱 완료: {result.get('key')} {result.get('scale')}, {len(result.get('notes', []))} 음표")
            return JSONResponse(result)

        # 이미지/PDF → OMR + Claude Vision AI 분석
        if file.content_type in IMAGE_TYPES or ext in {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'}:
            # OMR 분석 (오선지 인식)
            omr_result = None
            if OMR_AVAILABLE and ext not in {'.pdf'}:
                try:
                    omr_result = analyze_with_omr(contents)
                    logger.info(f"🔍 OMR: {omr_result.get('detection_summary', {}).get('note_count', 0)}개 음표 감지")
                except Exception as omr_err:
                    logger.warning(f"OMR 분석 실패: {omr_err}")

            # AI 분석 (Claude Vision)
            ai_result = None
            try:
                ai_result = await analyze_with_ai(contents, file.content_type)
            except Exception as ai_err:
                logger.warning(f"AI 분석 실패: {ai_err}")

            # 결과 결정: AI 결과 우선, 실패 시 OMR 기반 결과 사용
            if ai_result and ai_result.get("success"):
                result = ai_result
            elif omr_result and omr_result.get("success"):
                # OMR 결과로 기본 분석 데이터 생성
                omr_notes = omr_result.get("notes", [])
                result = {
                    "success": True,
                    "key": "C",
                    "scale": "Major",
                    "key_display": "C Major",
                    "time_signature": "4/4",
                    "tempo": 120,
                    "clef": "treble",
                    "notes": omr_notes,
                    "raw_analysis": "OMR 엔진 분석 결과 (AI 분석 불가 — OpenAI API 키를 확인하세요)\n"
                                    f"오선: {omr_result.get('detection_summary',{}).get('staff_count',0)}개 감지\n"
                                    f"음표: {len(omr_notes)}개 감지\n"
                                    f"마디: {omr_result.get('measures',0)}개",
                    "confidence": omr_result.get("confidence", 0.5),
                    "engine": "omr",
                }
            else:
                result = get_demo_data()
                result["raw_analysis"] = "AI 및 OMR 분석 모두 실패했습니다. 데모 데이터를 표시합니다."

            # OMR 결과 병합
            if omr_result and omr_result.get("success"):
                result["omr"] = {
                    "staffs": omr_result.get("staffs", []),
                    "notes": omr_result.get("notes", []),
                    "measures": omr_result.get("measures", 0),
                    "annotated_image": omr_result.get("annotated_image", ""),
                    "detection_summary": omr_result.get("detection_summary", {}),
                    "confidence": omr_result.get("confidence", 0),
                }

            logger.info(f"✅ 분석 완료: {result.get('key')} {result.get('scale')}, {len(result.get('notes', []))} 음표")
            return JSONResponse(result)

        raise HTTPException(400, f"지원하지 않는 파일 형식입니다: {ext or file.content_type}\n지원: MusicXML, MIDI, 이미지(JPG/PNG)")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ 분석 오류: {e}")
        raise HTTPException(500, f"분석 중 오류 발생: {str(e)}")

@app.post("/transpose")
async def transpose_score(req: TransposeRequest):
    """음표 조 변환"""
    logger.info(f"🎵 변환 요청: {req.original_key} → {req.target_key} ({req.semitones:+d} 반음)")

    try:
        notes_list = [n.dict() for n in req.notes]

        if MUSIC21_AVAILABLE:
            transposed_notes = transpose_with_music21(notes_list, req.semitones, req.use_flats)
        else:
            transposed_notes = []
            for n in req.notes:
                transposed = transpose_note_local(n, req.semitones, req.use_flats)
                transposed_notes.append(transposed.dict())

        logger.info(f"✅ 변환 완료: {len(transposed_notes)} 음표")
        return JSONResponse({
            "success": True,
            "original_key": req.original_key,
            "target_key": req.target_key,
            "semitones": req.semitones,
            "notes": transposed_notes,
            "time_signature": req.time_signature,
            "tempo": req.tempo,
            "engine": "music21" if MUSIC21_AVAILABLE else "local",
        })
    except Exception as e:
        logger.error(f"❌ 변환 오류: {e}")
        raise HTTPException(500, f"변환 중 오류 발생: {str(e)}")

@app.post("/omr-analyze")
async def omr_analyze(file: UploadFile = File(...)):
    """OMR 전용 분석 — 오선지 인식 기반 음표 감지"""
    if not OMR_AVAILABLE:
        raise HTTPException(500, "OMR 엔진이 사용 불가합니다 (OpenCV 미설치)")

    contents = await file.read()
    if len(contents) > 20 * 1024 * 1024:
        raise HTTPException(400, "파일 크기가 20MB를 초과합니다")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext in {'.pdf'}:
        raise HTTPException(400, "OMR은 이미지 파일만 지원합니다 (JPG, PNG)")

    try:
        result = analyze_with_omr(contents)
        return JSONResponse(result)
    except Exception as e:
        logger.error(f"OMR 분석 오류: {e}")
        raise HTTPException(500, f"OMR 분석 오류: {str(e)}")

@app.get("/keys")
async def get_keys():
    """지원 조성 목록"""
    return {
        "major": ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db'],
        "minor": ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D', 'G', 'C', 'F', 'Bb', 'Eb'],
    }

# ═══════════════════════════════════════════════════════════════
#   프론트엔드 정적 파일 서빙 (모든 API 라우트 등록 이후, 항상 마지막에 mount)
# ═══════════════════════════════════════════════════════════════
DOCS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")
if os.path.isdir(DOCS_DIR):
    # html=True: index.html을 "/"에서 자동 서빙하고, transpose.html/viewer.html 등
    # docs/ 아래 다른 정적 파일도 파일명 그대로 서빙한다.
    app.mount("/", StaticFiles(directory=DOCS_DIR, html=True), name="docs")
    logger.info(f"✅ 프론트엔드 서빙: {DOCS_DIR}")

# ═══════════════════════════════════════════════════════════════
#   실행
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    logger.info("🚀 ScoreShift 백엔드 서버 시작...")
    logger.info(f"   AI API: {'✅ 사용 가능' if AI_AVAILABLE else '❌ API 키 없음'}")
    logger.info(f"   music21:    {'✅ 사용 가능' if MUSIC21_AVAILABLE else '❌ 미설치'}")
    logger.info("   http://0.0.0.0:8000 에서 실행 중")
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
