# 🎵 ScoreShift — AI 악보 조 변환기

> GPT-4 Vision으로 악보를 인식하고, music21로 정확하게 조를 변환하는 웹 서비스

![ScoreShift Preview](https://via.placeholder.com/800x400/0a0a0f/7c6bff?text=ScoreShift+AI+%EC%95%85%EB%B3%B4+%EC%A1%B0+%EB%B3%80%ED%99%98%EA%B8%B0)

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| 🤖 **AI 악보 인식** | GPT-4 Vision이 악보 이미지를 분석해 음표, 조성, 박자 추출 |
| 🎵 **조 자동 감지** | 장조/단조 자동 인식 및 조표 분석 |
| 🔄 **정확한 조 변환** | music21 엔진으로 모든 음표를 정확하게 이조 |
| 📊 **비교 뷰** | 원본 vs 변환본 나란히 보기 |
| 📥 **다양한 내보내기** | PNG, SVG, JSON, MusicXML 형식 다운로드 |

---

## 📁 프로젝트 구조

```
music-transposer/
├── 📂 frontend/           # 프론트엔드 (HTML/CSS/JS)
│   ├── index.html         # 메인 페이지
│   ├── css/
│   │   └── style.css      # 전체 스타일 (다크 테마)
│   └── js/
│       ├── main.js        # 앱 로직 (업로드, 분석, 변환)
│       ├── api.js         # 백엔드 통신 + 로컬 폴백
│       └── vexflow-handler.js  # VexFlow 악보 렌더링
│
├── 📂 backend/            # 백엔드 (Python FastAPI)
│   ├── app.py             # FastAPI 서버
│   ├── requirements.txt   # Python 패키지 목록
│   └── .env.example       # 환경 변수 예시
│
├── 📂 .vscode/            # VS Code 설정
│   ├── launch.json        # 디버그 실행 설정
│   ├── settings.json      # 에디터 설정
│   └── extensions.json    # 추천 확장 프로그램
│
├── .gitignore
└── README.md
```

---

## 🚀 빠른 시작

### 1단계 — VS Code에서 열기

```bash
# 폴더를 VS Code로 열기
code music-transposer
```

### 2단계 — 백엔드 설정

```bash
# 백엔드 폴더로 이동
cd backend

# 가상환경 생성 (권장)
python -m venv venv

# 가상환경 활성화
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# 패키지 설치
pip install -r requirements.txt

# 환경 변수 설정
cp .env.example .env
# .env 파일을 열고 OPENAI_API_KEY 입력
```

### 3단계 — OpenAI API 키 설정

`.env` 파일에 OpenAI API 키를 입력합니다:
```env
OPENAI_API_KEY=sk-your-api-key-here
```
> 🔑 API 키는 https://platform.openai.com/api-keys 에서 발급

### 4단계 — 백엔드 서버 실행

```bash
# backend 폴더에서
python app.py
```
또는 VS Code에서 `F5` → "🚀 ScoreShift Backend 실행" 선택

### 5단계 — 프론트엔드 실행

**방법 A: Live Server (추천)**
1. VS Code에서 `frontend/index.html` 열기
2. 우하단 "Go Live" 클릭
3. 브라우저에서 `http://localhost:5500` 접속

**방법 B: 직접 파일 열기**
- `frontend/index.html` 을 브라우저에서 직접 실행

---

## ⚙️ API 키 없이 사용하기

OpenAI API 키 없이도 **데모 모드**로 모든 UI와 기능을 테스트할 수 있습니다.
- 백엔드 없이 프론트엔드만 실행 → 자동으로 샘플 데이터 사용
- 조 변환 로직은 로컬에서도 완전히 동작

---

## 🛠️ 기술 스택

### Frontend
- **HTML5 / CSS3 / Vanilla JavaScript** — 의존성 없는 순수 웹
- **[VexFlow 4.x](https://vexflow.com/)** — 악보 렌더링 라이브러리
- **Google Fonts** — Inter + JetBrains Mono

### Backend
- **[FastAPI](https://fastapi.tiangolo.com/)** — 고성능 Python 웹 프레임워크
- **[OpenAI GPT-4o Vision](https://platform.openai.com/docs/guides/vision)** — 악보 이미지 AI 분석
- **[music21](https://web.mit.edu/music21/)** — MIT 음악 이론 라이브러리

---

## 🔌 API 엔드포인트

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
