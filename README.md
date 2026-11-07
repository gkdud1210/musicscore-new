# 🎵 ScoreShift — 악보 라이브러리 & 필기 앱

> PDF 악보를 업로드하면 제목·가사·코드를 자동 인식해 검색할 수 있는 개인용 악보
> 라이브러리. 아이패드에서 PDF 위에 직접 필기하고, 필기가 반영된 PDF로 내보낼 수
> 있습니다. 조 옮김(조 변환)은 부가 기능으로 함께 제공됩니다.

![ScoreShift Preview](https://via.placeholder.com/800x400/0a0a0f/7c6bff?text=ScoreShift+AI+%EC%95%85%EB%B3%B4+%EC%A1%B0+%EB%B3%80%ED%99%98%EA%B8%B0)

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| 📚 **콘티 업로드** | 콘티 PDF 여러 개를 한 번에 업로드 (드래그 앤 드롭 가능). 파일명/표지에서 날짜 자동 인식 |
| 🧩 **곡 단위 자동 분리** | 페이지마다 제목을 읽어서 곡별로 나눔 (2페이지짜리 곡은 하나로). 틀리면 합치기/나누기/빼기로 보정 |
| 🎹 **키(조) 자동 인식** | "Key: G", "G코드", "사장조" 같은 표기를 읽고, 없으면 코드 진행으로 키를 추정 |
| 🔍 **제목/가사/키/코드 검색** | 띄어쓰기 상관없이 제목·가사 검색, 키별·포함 코드별 필터. 결과는 악보 이미지 그대로 표시 |
| 🎼 **새 콘티 PDF 만들기** | 곡을 골라 담고 순서를 정해서 하나의 PDF로 내보내기 (곡별 책갈피, 필기 포함 옵션) |
| 📁 **지난 콘티 보기** | 업로드한 콘티를 날짜순으로 보고, 콘티 전체를 새 콘티에 담기 |
| ✏️ **필기(잉크) 주석** | 애플펜슬/마우스로 PDF 위에 직접 필기, 페이지별 자동 저장 |
| ⬇️ **필기 반영 PDF 내보내기** | 필기가 벡터로 구워진 PDF를 다운로드 |
| ✋ **수동 보정** | OCR로 잘못 인식된 제목/코드를 언제든 직접 수정 |
| 🔄 **조 변환 (부가 기능)** | Claude Vision + music21로 악보를 분석해 원하는 조로 이조 |

---

## 📁 프로젝트 구조

```
Musicscore-new/
├── 📂 docs/                    # 프론트엔드 (HTML/CSS/JS, 빌드 스텝 없음)
│   ├── index.html              # 라이브러리 홈 (메인 화면)
│   ├── viewer.html             # PDF 뷰어 + 필기
│   ├── transpose.html          # 조 변환 (부가 기능, 기존 위저드)
│   ├── css/style.css           # 전체 스타일 (다크 테마)
│   └── js/
│       ├── library.js          # 라이브러리 목록/검색/코드필터/업로드
│       ├── viewer.js           # PDF.js 렌더 + 페이지 이동/줌
│       ├── annotate.js         # 필기(잉크) 캡처/저장
│       ├── api.js              # 백엔드 통신 + 공용 유틸
│       ├── main.js             # 조 변환 위저드 로직
│       └── vexflow-handler.js  # VexFlow 악보 렌더링
│
├── 📂 backend/                 # 백엔드 (Python FastAPI)
│   ├── app.py                  # FastAPI 서버 (조 변환 API + 정적 파일 서빙)
│   ├── library.py              # 라이브러리 API (업로드/검색/필기/내보내기)
│   ├── ocr.py                  # PDF OCR 파이프라인 (제목/가사/코드 인식)
│   ├── db.py                   # sqlite3 데이터 계층
│   ├── omr.py                  # OMR(오선지 인식) 엔진
│   ├── storage/                # 업로드된 PDF/DB (gitignore, 기기별 데이터)
│   ├── requirements.txt        # Python 패키지 목록
│   └── .env.example            # 환경 변수 예시
│
├── .gitignore
└── README.md
```

---

## 🚀 빠른 시작

### 1단계 — 시스템 요구사항 설치 (Tesseract OCR)

라이브러리의 제목/가사/코드 자동 인식은 **로컬 Tesseract OCR**을 사용합니다 (비용 없음,
서버에서 실행). macOS 기준:

```bash
brew install tesseract tesseract-lang   # tesseract-lang에 한국어(kor) 데이터 포함
tesseract --list-langs                  # kor, eng 가 보이는지 확인
```

### 2단계 — 백엔드 설정

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# (선택) .env 파일에 ANTHROPIC_API_KEY 입력 — 조 변환 기능의 Claude Vision 분석에만 필요.
# 라이브러리 기능(업로드/검색/필기)은 API 키 없이도 완전히 동작합니다.
```

### 3단계 — 서버 실행

```bash
# backend 폴더에서
python app.py
```
`http://localhost:8000` 에 접속하면 라이브러리 홈이 바로 뜹니다 (백엔드가 `docs/`
프론트엔드를 함께 서빙합니다 — 별도 프론트엔드 서버가 필요 없습니다).

### 4단계 — 아이패드에서 접속하기

라이브러리/필기 기능은 **백엔드가 필요**하므로, 백엔드를 실행 중인 Mac의 로컬 IP로
아이패드 Safari에서 접속하세요 (같은 Wi-Fi에 연결되어 있어야 함):

```
http://<Mac의 로컬 IP>:8000
```

> ⚠️ **GitHub Pages(`docs/`를 정적 배포한 주소)에서는 라이브러리 기능이 동작하지
> 않습니다.** GitHub Pages는 HTTPS인데 로컬 백엔드는 보통 HTTP라서, 브라우저가
> mixed-content로 요청을 차단합니다. GitHub Pages 배포본은 조 변환(부가 기능) 데모
> 용으로만 사용하고, 라이브러리는 항상 백엔드가 직접 서빙하는 주소로 접속하세요.

---

## ⚙️ API 키 없이 사용하기

**라이브러리 기능(업로드/OCR/검색/코드필터/필기/내보내기)은 처음부터 API 키가
필요 없습니다** — 전부 로컬 Tesseract OCR + PyMuPDF로 동작합니다.

조 변환(부가 기능)만 `ANTHROPIC_API_KEY` 없이는 데모 데이터로 대체됩니다.

---

## 🛠️ 기술 스택

### Frontend
- **HTML5 / CSS3 / Vanilla JavaScript** — 의존성 없는 순수 웹, 빌드 스텝 없음
- **[PDF.js](https://mozilla.github.io/pdf.js/)** — 브라우저에서 PDF 페이지 렌더링
- **Pointer Events API** — 애플펜슬/마우스 필기 입력
- **[VexFlow 4.x](https://vexflow.com/)** — 조 변환 페이지의 악보 렌더링
- **Google Fonts** — Inter + JetBrains Mono

### Backend
- **[FastAPI](https://fastapi.tiangolo.com/)** — 고성능 Python 웹 프레임워크
- **[PyMuPDF (fitz)](https://pymupdf.readthedocs.io/)** — PDF 렌더링/썸네일/필기 벡터 굽기
- **[pytesseract](https://github.com/madmaze/pytesseract) + Tesseract OCR** — 로컬 제목/가사/코드 인식
- **stdlib `sqlite3`** — 라이브러리 메타데이터/필기 저장 (별도 DB 서버 불필요)
- **[Anthropic Claude Vision](https://docs.anthropic.com/)** — 조 변환(부가 기능)의 악보 이미지 분석
- **[music21](https://web.mit.edu/music21/)** — MIT 음악 이론 라이브러리

---

## 🔌 API 엔드포인트

### 악보 라이브러리 (메인 기능)

| Method | URL | 설명 |
|--------|-----|------|
| `POST`   | `/api/scores` | PDF 업로드 → 저장 + OCR 처리 |
| `GET`    | `/api/scores?q=&chords=` | 목록/검색/코드 필터 |
| `GET`    | `/api/scores/{id}` | 악보 상세 |
| `PATCH`  | `/api/scores/{id}` | 제목/코드 수동 수정 |
| `DELETE` | `/api/scores/{id}` | 악보 삭제 |
| `GET`    | `/api/scores/{id}/file` | 원본 PDF |
| `GET`    | `/api/scores/{id}/thumbnail` | 썸네일 이미지 |
| `GET`/`PUT` | `/api/scores/{id}/annotations/{page}` | 페이지별 필기 조회/저장 |
| `GET`    | `/api/scores/{id}/export` | 필기가 반영된 PDF 다운로드 |
| `POST`   | `/api/scores/{id}/analyze-page/{page}` | 해당 페이지를 조 변환 파이프라인으로 분석 |

### 조 변환 (부가 기능)

| Method | URL | 설명 |
|--------|-----|------|
| `GET`  | `/health` | 서버 상태 확인 |
| `POST` | `/analyze` | 악보 이미지 분석 |
| `POST` | `/transpose` | 음표 조 변환 |
| `GET`  | `/keys` | 지원 조성 목록 |
| `GET`  | `/docs` | Swagger API 문서 |

### 예시 요청

```bash
# 악보 분석
curl -X POST http://localhost:8000/analyze \
  -F "file=@my_score.png"

# 조 변환 (C → G, +7 반음)
curl -X POST http://localhost:8000/transpose \
  -H "Content-Type: application/json" \
  -d '{
    "notes": [{"pitch": "C", "octave": 4, "duration": "q"}],
    "original_key": "C",
    "target_key": "G",
    "semitones": 7
  }'
```

---

## 🎨 확장 아이디어

- [ ] MIDI 파일 업로드/다운로드 지원
- [ ] PDF 악보 다운로드
- [ ] 구간 선택 변환 (일부 마디만)
- [ ] 여러 성부 (voice) 동시 변환
- [ ] 악보 편집 기능 (음표 추가/삭제)
- [ ] MuseScore / Finale / Sibelius 연동
- [ ] 모바일 카메라 촬영 → 실시간 분석

---

## 📄 라이선스

MIT License — 자유롭게 사용, 수정, 배포 가능합니다.
