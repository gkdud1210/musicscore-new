/**
 * Main Application Logic
 * ScoreShift AI 악보 조 변환기
 */

/* ============================================================
   전역 상태
   ============================================================ */
const AppState = {
  uploadedFile: null,
  analysisData: null,
  transposedData: null,
  selectedTargetKey: null,
  currentSemitones: 0,
  activeTab: 'original',
};

/* ============================================================
   MAJOR / MINOR 키 목록
   ============================================================ */
const MAJOR_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db'];
const MINOR_KEYS = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D', 'G', 'C', 'F', 'Bb', 'Eb'];

/* ============================================================
   초기화
   ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
  initUploadZone();
  renderKeyButtons();
  initBackgroundParticles();
});

/* ============================================================
   배경 파티클
   ============================================================ */
function initBackgroundParticles() {
  const container = document.getElementById('bgParticles');
  if (!container) return;
  const colors = ['#7c6bff', '#ec4899', '#06b6d4', '#22c55e', '#f59e0b'];
  const notes  = ['♩', '♪', '♫', '♬', '𝄞'];

  for (let i = 0; i < 18; i++) {
    const el = document.createElement('div');
    el.className = 'particle';
    const size = Math.random() * 16 + 8;
    el.style.cssText = `
      width: ${size}px; height: ${size}px;
      left: ${Math.random() * 100}%;
      animation-duration: ${Math.random() * 12 + 8}s;
      animation-delay: ${Math.random() * 10}s;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      opacity: 0.15;
      border-radius: 50%;
    `;
    container.appendChild(el);
  }

  // 음표 파티클
  for (let i = 0; i < 8; i++) {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute;
      font-size: ${Math.random() * 18 + 14}px;
      left: ${Math.random() * 100}%;
      animation: floatParticle ${Math.random() * 14 + 10}s linear infinite;
      animation-delay: ${Math.random() * 12}s;
      opacity: 0;
      pointer-events: none;
      color: ${colors[Math.floor(Math.random() * colors.length)]};
    `;
    el.textContent = notes[Math.floor(Math.random() * notes.length)];
    container.appendChild(el);
  }
}

/* ============================================================
   업로드 존 초기화
   ============================================================ */
function initUploadZone() {
  const area  = document.getElementById('uploadArea');
  const input = document.getElementById('fileInput');

  area.addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') input.click();
  });

  area.addEventListener('dragover', e => {
    e.preventDefault();
    area.classList.add('drag-over');
  });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  });

  input.addEventListener('change', e => {
    if (e.target.files[0]) handleFileSelect(e.target.files[0]);
  });
}

function handleFileSelect(file) {
  const allowedMime = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  const musicExts = ['.xml', '.musicxml', '.mxl', '.mid', '.midi', '.krn', '.abc'];
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  const isMusicFile = musicExts.includes(ext);

  if (!allowedMime.includes(file.type) && !isMusicFile) {
    showToast('MusicXML, MIDI, JPG, PNG, PDF 파일을 지원합니다.', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showToast('20MB 이하 파일만 업로드 가능합니다.', 'error');
    return;
  }

  AppState.uploadedFile = file;

  // 미리보기
  if (isMusicFile) {
    // 악보 파일 (MusicXML, MIDI 등)
    const iconMap = {'.mid': '🎹', '.midi': '🎹'};
    const icon = iconMap[ext] || '🎼';
    const typeLabel = ext.toUpperCase().replace('.', '');
    document.getElementById('uploadPlaceholder').classList.add('hidden');
    const prev = document.getElementById('uploadPreview');
    prev.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px;color:var(--text-secondary)">
        <span style="font-size:52px">${icon}</span>
        <p style="font-weight:600">${typeLabel} 악보 파일 선택됨</p>
        <p style="font-size:13px;color:var(--text-muted)">music21 엔진으로 로컬 분석 (API 불필요)</p>
        <button class="btn-sm" onclick="resetUpload()">다시 선택</button>
      </div>`;
    prev.classList.remove('hidden');
  } else if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById('previewImg').src = e.target.result;
      document.getElementById('uploadPlaceholder').classList.add('hidden');
      document.getElementById('uploadPreview').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  } else {
    document.getElementById('uploadPlaceholder').classList.add('hidden');
    const prev = document.getElementById('uploadPreview');
    prev.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px;color:var(--text-secondary)">
        <span style="font-size:52px">📄</span>
        <p style="font-weight:600">PDF 파일 선택됨</p>
        <button class="btn-sm" onclick="resetUpload()">다시 선택</button>
      </div>`;
    prev.classList.remove('hidden');
  }

  // 파일 정보
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent  = formatBytes(file.size);
  document.getElementById('fileType').textContent  = isMusicFile ? ext.toUpperCase().replace('.', '') : (file.type.split('/')[1] || '').toUpperCase();
  document.getElementById('uploadInfo').classList.remove('hidden');
  document.getElementById('analyzeBtn').disabled   = false;

  showToast(`"${file.name}" 업로드 완료!`, 'success');
}

function resetUpload() {
  AppState.uploadedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadPreview').classList.add('hidden');
  document.getElementById('uploadPlaceholder').classList.remove('hidden');
  document.getElementById('uploadInfo').classList.add('hidden');
  document.getElementById('analyzeBtn').disabled = true;
}

/* ============================================================
   AI 분석
   ============================================================ */
async function analyzeScore() {
  if (!AppState.uploadedFile) return;

  // 분석 섹션 표시
  showSection('analysis-section');
  document.getElementById('analysisLoading').style.display = 'flex';
  document.getElementById('analysisResult').classList.add('hidden');

  // 로딩 상태 업데이트
  animateLoadingStatus([
    '이미지를 AI에 전송 중...',
    '악보를 분석 중...',
    '음표와 조성을 인식 중...',
    '박자와 리듬을 파악 중...',
    '분석 결과를 정리하는 중...',
  ]);

  try {
    const result = await apiAnalyzeScore(AppState.uploadedFile);
    AppState.analysisData = result;

    if (!result.success) throw new Error(result.error || '분석 실패');

    // 로딩 숨기고 결과 표시
    await sleep(600);
    document.getElementById('analysisLoading').style.display = 'none';
    document.getElementById('analysisResult').classList.remove('hidden');

    displayAnalysisResult(result);
    showSection('transpose-section');

    showToast('악보 분석 완료!', 'success');
  } catch (e) {
    document.getElementById('analysisLoading').style.display = 'none';
    showToast('분석 중 오류가 발생했습니다: ' + e.message, 'error');
    console.error(e);
  }
}

function animateLoadingStatus(messages, idx = 0) {
  const el = document.getElementById('loadingStatus');
  if (!el) return;
  if (idx >= messages.length) return;
  el.textContent = messages[idx];
  setTimeout(() => animateLoadingStatus(messages, idx + 1), 900);
}

function displayAnalysisResult(data) {
  const notes = data.notes || [];

  // -- 신뢰도 --
  const confidence = Math.round((data.confidence || 0) * 100);
  const confFill = document.getElementById('confidenceFill');
  const confValue = document.getElementById('confidenceValue');
  if (confFill) confFill.style.width = confidence + '%';
  if (confValue) confValue.textContent = confidence + '%';
  // 색상 변화: 80+ 초록, 50-79 주황, <50 빨강
  if (confFill) {
    if (confidence >= 80) confFill.style.background = 'linear-gradient(90deg, var(--green), #34d399)';
    else if (confidence >= 50) confFill.style.background = 'linear-gradient(90deg, var(--amber), #fbbf24)';
    else confFill.style.background = 'linear-gradient(90deg, var(--pink), #f87171)';
  }

  // -- 핵심 정보 카드 --
  document.getElementById('detectedKey').textContent  = `${data.key} ${data.scale}`;
  document.getElementById('detectedScale').textContent = getKeyDescription(data.key, data.scale);
  document.getElementById('timeSignature').textContent = data.time_signature || '4/4';
  document.getElementById('tempoValue').textContent    = data.tempo || '—';
  document.getElementById('noteCount').textContent     = notes.length;
  document.getElementById('notesBadge').textContent    = `${notes.length}개`;

  // 음자리표
  const clefMap = { 'treble': '높은음자리표 (𝄞)', 'bass': '낮은음자리표 (𝄢)', 'alto': '가온음자리표', 'tenor': '테너음자리표' };
  document.getElementById('clefValue').textContent = clefMap[data.clef] || data.clef || '높은음자리표 (𝄞)';

  // 마디 수 계산
  const measureSet = new Set();
  notes.forEach(n => { if (n.measure) measureSet.add(n.measure); });
  const measureTotal = measureSet.size || (notes.length > 0 ? 1 : 0);
  document.getElementById('measureCount').textContent = measureTotal;
  document.getElementById('measureBadge').textContent = `${measureTotal} 마디`;

  // -- 업로드 이미지 미리보기 (검증용) --
  displayVerifyImage();

  // -- OMR 결과 표시 --
  displayOmrResult(data.omr);

  // -- 마디별 분석 --
  buildMeasureBreakdown(notes, data.time_signature || '4/4');

  // -- 계이름 패널 --
  buildSolfegePanel(notes);

  // 음표 테이블
  buildNotesTable('notesTableBody', notes);

  // 원본 키 배지 업데이트
  const origKeyBadge = document.getElementById('originalKeyBadge');
  if (origKeyBadge) origKeyBadge.textContent = `${data.key} ${data.scale || 'Major'}`;

  // 원본 악보 렌더링 (계이름 표시 포함)
  if (notes.length > 0) {
    setTimeout(() => {
      try {
        renderScore('originalScoreRender', notes, data.key, data.time_signature || '4/4', { showSolfege: true });
      } catch(e) { console.warn('Score render failed:', e); }
    }, 100);
  }

  // AI 원문
  document.getElementById('aiRawContent').textContent = data.raw_analysis || '분석 결과 없음';

  // 조 변환 섹션 초기화
  initTransposeSection(data.key, data.scale);
}

/**
 * 업로드한 악보를 검증 패널에 표시
 */
function displayVerifyImage() {
  const file = AppState.uploadedFile;
  const imgEl = document.getElementById('verifyPreviewImg');
  const placeholder = document.getElementById('verifyImagePlaceholder');

  if (!file) return;

  const musicExts = ['.xml', '.musicxml', '.mxl', '.mid', '.midi', '.krn', '.abc'];
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  const isMusicFile = musicExts.includes(ext);

  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = e => {
      imgEl.src = e.target.result;
      imgEl.style.display = 'block';
      placeholder.style.display = 'none';
    };
    reader.readAsDataURL(file);
  } else {
    imgEl.style.display = 'none';
    placeholder.style.display = 'flex';
    const icon = isMusicFile ? '🎼' : '📄';
    const label = isMusicFile ? ext.toUpperCase().replace('.', '') + ' 파일' : 'PDF 파일';
    placeholder.innerHTML = `<span style="font-size:40px">${icon}</span><p>${label}</p><p style="font-size:11px;color:var(--text-muted)">${file.name}</p>`;
  }
}

/**
 * 마디별 음표 구성 빌드
 */
function buildMeasureBreakdown(notes, timeSig) {
  const container = document.getElementById('measureBreakdownContent');
  if (!container) return;
  container.innerHTML = '';

  // 마디별 그룹핑
  const measures = {};
  notes.forEach(n => {
    const m = n.measure || 1;
    if (!measures[m]) measures[m] = [];
    measures[m].push(n);
  });

  const measureNums = Object.keys(measures).map(Number).sort((a, b) => a - b);
  if (measureNums.length === 0) {
    container.innerHTML = '<p style="padding:20px;color:var(--text-muted)">마디 정보 없음</p>';
    return;
  }

  measureNums.forEach(num => {
    const mNotes = measures[num];
    const row = document.createElement('div');
    row.className = 'measure-row';

    const noteChips = mNotes.map(n => {
      if (n.type === 'rest') {
        return `<span class="measure-chip rest" title="${durationKo(n.duration)}">쉼</span>`;
      }
      const solfege = pitchToSolfege(n.pitch, n.accidental);
      return `<span class="measure-chip" title="${n.pitch}${n.octave || ''} · ${durationKo(n.duration)}">
        <span class="mc-solfege">${solfege}</span>
        <span class="mc-pitch">${n.pitch}${n.octave || ''}</span>
        <span class="mc-dur">${durationKo(n.duration)}</span>
      </span>`;
    }).join('');

    const noteOnlyCount = mNotes.filter(n => n.type !== 'rest').length;
    const restCount = mNotes.filter(n => n.type === 'rest').length;
    let countLabel = `${noteOnlyCount}개 음표`;
    if (restCount > 0) countLabel += ` + ${restCount}개 쉼표`;

    row.innerHTML = `
      <div class="measure-num">
        <span class="measure-num-label">마디</span>
        <span class="measure-num-value">${num}</span>
      </div>
      <div class="measure-notes">${noteChips}</div>
      <div class="measure-info">${countLabel}</div>
    `;
    container.appendChild(row);
  });
}

function toggleMeasureBreakdown() {
  const el = document.getElementById('measureBreakdownContent');
  const toggle = document.getElementById('measureToggle');
  const isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden', !isHidden);
  toggle.textContent = isHidden ? '▲ 접기' : '▼ 펼치기';
}

/* ============================================================
   OMR (오선지 인식) 결과 표시
   ============================================================ */
function displayOmrResult(omr) {
  const panel = document.getElementById('omrPanel');
  if (!panel) return;

  if (!omr || !omr.annotated_image) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  // 주석 이미지
  const img = document.getElementById('omrAnnotatedImg');
  img.src = 'data:image/png;base64,' + omr.annotated_image;

  // 통계
  const summary = omr.detection_summary || {};
  document.getElementById('omrStaffCount').textContent = summary.staff_count || 0;
  document.getElementById('omrNoteCount').textContent = summary.note_count || 0;
  document.getElementById('omrMeasureCount').textContent = summary.measure_count || 0;
  document.getElementById('omrConfidence').textContent = Math.round((omr.confidence || 0) * 100) + '%';

  // 배지
  const badge = document.getElementById('omrBadge');
  badge.textContent = `${summary.staff_count || 0}개 오선 · ${summary.note_count || 0}개 음표`;

  // OMR 감지 음표 목록
  const list = document.getElementById('omrNotesList');
  list.innerHTML = '';

  if (omr.notes && omr.notes.length > 0) {
    const header = document.createElement('div');
    header.className = 'omr-notes-header';
    header.textContent = 'OMR 감지 음표 (오선 위치 기반)';
    list.appendChild(header);

    // 마디별 그룹
    const measures = {};
    omr.notes.forEach(n => {
      const m = n.measure || 1;
      if (!measures[m]) measures[m] = [];
      measures[m].push(n);
    });

    Object.keys(measures).sort((a,b) => a-b).forEach(mNum => {
      const mRow = document.createElement('div');
      mRow.className = 'omr-measure-row';
      const mLabel = document.createElement('span');
      mLabel.className = 'omr-measure-label';
      mLabel.textContent = `마디 ${mNum}`;
      mRow.appendChild(mLabel);

      measures[mNum].forEach(n => {
        const chip = document.createElement('span');
        chip.className = 'omr-note-chip';
        const solfege = pitchToSolfege(n.pitch, n.accidental);
        chip.innerHTML = `<strong>${solfege}</strong><small>${n.pitch}${n.octave}</small>`;
        chip.title = `${n.pitch}${n.octave} · ${durationKo(n.duration)}`;
        mRow.appendChild(chip);
      });

      list.appendChild(mRow);
    });
  }
}

function toggleOmrPanel() {
  const el = document.getElementById('omrContent');
  const toggle = document.getElementById('omrToggle');
  const isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden', !isHidden);
  toggle.textContent = isHidden ? '▲ 접기' : '▼ 펼치기';
}

/* ============================================================
   계이름 변환 (C→도, D→레 ...)
   ============================================================ */
const SOLFEGE_MAP = {
  'C': '도', 'D': '레', 'E': '미', 'F': '파', 'G': '솔', 'A': '라', 'B': '시',
  'C#': '도#', 'D#': '레#', 'F#': '파#', 'G#': '솔#', 'A#': '라#',
  'Db': '레b', 'Eb': '미b', 'Gb': '솔b', 'Ab': '라b', 'Bb': '시b',
};

function pitchToSolfege(pitch, accidental) {
  if (!pitch) return '—';
  const key = pitch.replace('#', '').replace('b', '');
  const full = accidental ? key + accidental : pitch;
  return SOLFEGE_MAP[full] || SOLFEGE_MAP[key] || pitch;
}

function buildSolfegePanel(notes) {
  const flow = document.getElementById('solfegeFlow');
  const badge = document.getElementById('solfegeBadge');
  if (!flow) return;
  flow.innerHTML = '';

  const noteOnly = notes.filter(n => n.type !== 'rest');
  badge.textContent = `${noteOnly.length}개 음표`;

  let lastMeasure = 0;
  notes.forEach(n => {
    // 마디 구분선
    if (n.measure && n.measure !== lastMeasure && lastMeasure > 0) {
      const bar = document.createElement('div');
      bar.className = 'solfege-measure-bar';
      flow.appendChild(bar);
    }
    lastMeasure = n.measure || lastMeasure;

    const el = document.createElement('div');
    el.className = `solfege-note${n.type === 'rest' ? ' rest' : ''}`;

    if (n.type === 'rest') {
      el.innerHTML = `
        <span class="solfege-kr">쉼</span>
        <span class="solfege-en">${durationKo(n.duration)}</span>
      `;
    } else {
      const solfege = pitchToSolfege(n.pitch, n.accidental);
      el.innerHTML = `
        <span class="solfege-kr">${solfege}</span>
        <span class="solfege-en">${n.pitch}${n.octave || ''}</span>
        <span class="solfege-oct">${durationKo(n.duration)}</span>
      `;
    }
    flow.appendChild(el);
  });
}

function buildNotesTable(tbodyId, notes) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';
  notes.forEach((note, i) => {
    const tr = document.createElement('tr');
    const solfege = note.type === 'rest' ? '쉼표' : pitchToSolfege(note.pitch, note.accidental);
    tr.innerHTML = `
      <td class="text-muted">${i + 1}</td>
      <td class="note-name">${note.type === 'rest' ? '쉼표' : note.pitch + (note.accidental || '')}</td>
      <td class="note-solfege">${solfege}</td>
      <td class="text-muted">${note.octave || '—'}</td>
      <td class="note-duration">${durationKo(note.duration)}</td>
      <td class="note-measure">${note.measure || '—'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function durationKo(d) {
  const map = {
    'w':'온음표', 'whole':'온음표', '1':'온음표',
    'h':'2분음표', 'half':'2분음표', '2':'2분음표',
    'q':'4분음표', 'quarter':'4분음표', '4':'4분음표',
    '8':'8분음표', 'eighth':'8분음표',
    '16':'16분음표', 'sixteenth':'16분음표',
  };
  return map[d] || d || '4분음표';
}

function toggleRawAnalysis() {
  const el = document.getElementById('aiRawContent');
  const toggle = document.getElementById('rawToggle');
  const isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden', !isHidden);
  toggle.textContent = isHidden ? '▲ 접기' : '▼ 펼치기';
}

/* ============================================================
   조 변환 섹션 초기화
   ============================================================ */
function renderKeyButtons() {
  const majorContainer = document.getElementById('majorKeys');
  const minorContainer = document.getElementById('minorKeys');
  if (!majorContainer || !minorContainer) return;

  majorContainer.innerHTML = '';
  minorContainer.innerHTML = '';

  MAJOR_KEYS.forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'key-btn';
    btn.dataset.key = k;
    btn.dataset.mode = 'major';
    btn.textContent = `${k}`;
    btn.onclick = () => selectTargetKey(k, 'major');
    majorContainer.appendChild(btn);
  });

  MINOR_KEYS.forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'key-btn';
    btn.dataset.key = k;
    btn.dataset.mode = 'minor';
    btn.textContent = `${k}m`;
    btn.onclick = () => selectTargetKey(k, 'minor');
    minorContainer.appendChild(btn);
  });
}

function initTransposeSection(originalKey, originalScale) {
  // 현재 키 표시
  document.getElementById('currentKeyDisplay').textContent = `${originalKey}`;
  document.getElementById('currentAccidentals').textContent = getKeyAccidentalDisplay(originalKey, originalScale?.toLowerCase() || 'major');

  // 목표 키 초기값 = 원본 키
  selectTargetKey(originalKey, originalScale?.toLowerCase() || 'major', false);

  // 슬라이더 초기화
  document.getElementById('semitoneSlider').value = 0;
  document.getElementById('sliderValueDisplay').textContent = '0 반음';
  document.getElementById('semitoneBadge').textContent = '+0 반음';

  // 원본 키 버튼 강조
  document.querySelectorAll('.key-btn').forEach(btn => {
    btn.classList.remove('original-key');
    if (btn.dataset.key === originalKey) btn.classList.add('original-key');
  });
}

function selectTargetKey(key, mode = 'major', updateSlider = true) {
  AppState.selectedTargetKey = { key, mode };

  // 버튼 활성화
  document.querySelectorAll('.key-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.querySelector(`.key-btn[data-key="${key}"][data-mode="${mode}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  // 목표 키 표시
  document.getElementById('targetKeyDisplay').textContent = mode === 'minor' ? `${key}m` : key;
  document.getElementById('targetAccidentals').textContent = getKeyAccidentalDisplay(key, mode);

  if (updateSlider && AppState.analysisData) {
    const semitones = calculateSemitones(AppState.analysisData.key, key);
    AppState.currentSemitones = semitones;
    document.getElementById('semitoneSlider').value = semitones;
    document.getElementById('sliderValueDisplay').textContent = `${semitones > 0 ? '+' : ''}${semitones} 반음`;
    document.getElementById('semitoneBadge').textContent = `${semitones > 0 ? '+' : ''}${semitones} 반음`;
  }
}

function updateSemitone(value) {
  const n = parseInt(value);
  AppState.currentSemitones = n;
  document.getElementById('sliderValueDisplay').textContent = `${n > 0 ? '+' : ''}${n} 반음`;
  document.getElementById('semitoneBadge').textContent = `${n > 0 ? '+' : ''}${n} 반음`;

  // 슬라이더로 이동시 목표 키도 업데이트
  if (AppState.analysisData) {
    const noteArr = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const originalIdx = noteArr.indexOf(AppState.analysisData.key) || 0;
    const newIdx = ((originalIdx + n) % 12 + 12) % 12;
    const newKey = noteArr[newIdx];
    const mode = AppState.selectedTargetKey?.mode || 'major';
    document.getElementById('targetKeyDisplay').textContent = mode === 'minor' ? `${newKey}m` : newKey;
    document.getElementById('targetAccidentals').textContent = getKeyAccidentalDisplay(newKey, mode);

    document.querySelectorAll('.key-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.querySelector(`.key-btn[data-key="${newKey}"][data-mode="${mode}"]`);
    if (btn) btn.classList.add('active');

    AppState.selectedTargetKey = { key: newKey, mode };
  }
}

/* ============================================================
   조 변환 실행
   ============================================================ */
async function transposeScore() {
  if (!AppState.analysisData || !AppState.selectedTargetKey) {
    showToast('먼저 악보를 분석해주세요.', 'warning');
    return;
  }

  showSection('output-section');
  document.getElementById('transposeLoading').style.display = 'flex';
  document.getElementById('outputResult').classList.add('hidden');

  try {
    const options = {
      maintain_octave: document.getElementById('maintainOctave').checked,
      use_flats:       document.getElementById('useFlats').checked,
    };

    const result = await apiTransposeScore(
      AppState.analysisData,
      AppState.selectedTargetKey.key,
      AppState.currentSemitones,
      options
    );

    AppState.transposedData = result;

    await sleep(500);
    document.getElementById('transposeLoading').style.display = 'none';
    document.getElementById('outputResult').classList.remove('hidden');

    displayTransposedResult(result);
    showToast(`${result.original_key} → ${result.target_key} 변환 완료!`, 'success');
  } catch (e) {
    document.getElementById('transposeLoading').style.display = 'none';
    showToast('변환 중 오류가 발생했습니다: ' + e.message, 'error');
    console.error(e);
  }
}

function displayTransposedResult(data) {
  const origKey  = `${AppState.analysisData.key} ${AppState.analysisData.scale}`;
  const transKey = `${data.target_key} ${AppState.selectedTargetKey.mode === 'minor' ? 'Minor' : 'Major'}`;

  // 키 배지 업데이트
  ['outputOriginalKey', 'sbOriginalKey'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = origKey;
  });
  ['outputTransposedKey', 'sbTransposedKey'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = transKey;
  });

  // 악보 렌더링
  const origNotes   = AppState.analysisData.notes;
  const transNotes  = data.notes;
  const timeSig     = AppState.analysisData.time_signature || '4/4';
  const origKey2    = AppState.analysisData.key;
  const targetKey2  = data.target_key;

  setTimeout(() => {
    try {
      renderScore('outputOriginalScore',   origNotes,  origKey2,  timeSig);
      renderScore('outputTransposedScore', transNotes, targetKey2, timeSig);
      renderScore('sbOriginalScore',       origNotes,  origKey2,  timeSig);
      renderScore('sbTransposedScore',     transNotes, targetKey2, timeSig);
    } catch(e) { console.warn('Output render failed:', e); }
  }, 100);

  // 음표 비교 테이블
  buildComparisonTable(origNotes, transNotes);
}

function buildComparisonTable(origNotes, transNotes) {
  const tbody = document.getElementById('comparisonTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const maxLen = Math.max(origNotes.length, transNotes.length);
  for (let i = 0; i < maxLen; i++) {
    const orig  = origNotes[i];
    const trans = transNotes[i];
    const tr = document.createElement('tr');
    const origName  = orig  ? (orig.type  === 'rest' ? '쉼표' : orig.pitch)  : '—';
    const transName = trans ? (trans.type === 'rest' ? '쉼표' : trans.pitch) : '—';
    const duration  = orig ? durationKo(orig.duration) : '—';
    const measure   = orig ? (orig.measure || '—') : '—';
    const changed   = origName !== transName;

    tr.innerHTML = `
      <td class="text-muted">${i + 1}</td>
      <td style="color:var(--text-secondary)">${origName}${orig?.octave ? orig.octave : ''}</td>
      <td style="text-align:center;color:var(--text-muted)">→</td>
      <td style="color:${changed ? 'var(--green)' : 'var(--text-muted)'}; font-weight:${changed ? 700 : 400}">
        ${transName}${trans?.octave ? trans.octave : ''}
      </td>
      <td class="note-duration">${duration}</td>
      <td class="note-measure">${measure}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ============================================================
   탭 전환
   ============================================================ */
function showTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  document.getElementById(`tab-${tabName}`)?.classList.remove('hidden');
  document.querySelector(`.tab-btn[onclick="showTab('${tabName}')"]`)?.classList.add('active');
  AppState.activeTab = tabName;
}

/* ============================================================
   다운로드
   ============================================================ */
function downloadScore(format) {
  const targetId = AppState.activeTab === 'original' ? 'outputOriginalScore' : 'outputTransposedScore';
  const targetKey = AppState.transposedData?.target_key || 'transposed';
  const origKey   = AppState.analysisData?.key || 'original';
  const label     = AppState.activeTab === 'original' ? origKey : targetKey;

  if (format === 'svg') {
    const svg = exportScoreAsSVG(targetId);
    if (!svg) { showToast('SVG 내보내기 실패', 'error'); return; }
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `scoreshift_${label}.svg`);
    showToast('SVG 다운로드 시작!', 'success');
  } else if (format === 'png') {
    exportScoreAsPNG(targetId, dataUrl => {
      if (!dataUrl) { showToast('PNG 내보내기 실패', 'error'); return; }
      const a = document.createElement('a');
      a.href = dataUrl; a.download = `scoreshift_${label}.png`; a.click();
      showToast('PNG 다운로드 시작!', 'success');
    });
  } else if (format === 'json') {
    const jsonData = AppState.activeTab === 'original'
      ? AppState.analysisData
      : AppState.transposedData;
    downloadBlob(
      new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' }),
      `scoreshift_${label}.json`
    );
    showToast('JSON 다운로드 시작!', 'success');
  } else if (format === 'musicxml') {
    const notes = AppState.activeTab === 'original'
      ? AppState.analysisData?.notes
      : AppState.transposedData?.notes;
    const key   = AppState.activeTab === 'original'
      ? AppState.analysisData?.key
      : AppState.transposedData?.target_key;
    const xml = generateMusicXML(notes, key, AppState.analysisData?.time_signature || '4/4');
    downloadBlob(new Blob([xml], { type: 'application/xml' }), `scoreshift_${label}.musicxml`);
    showToast('MusicXML 다운로드 시작!', 'success');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * 간단한 MusicXML 생성
 */
function generateMusicXML(notes, key, timeSignature) {
  const [beats, beatType] = (timeSignature || '4/4').split('/');
  const DIVISIONS = 4;

  const durationMap = {
    'w': DIVISIONS * 4, 'whole': DIVISIONS * 4, '1': DIVISIONS * 4,
    'h': DIVISIONS * 2, 'half': DIVISIONS * 2, '2': DIVISIONS * 2,
    'q': DIVISIONS,     'quarter': DIVISIONS,   '4': DIVISIONS,
    '8': DIVISIONS / 2, 'eighth': DIVISIONS / 2,
    '16': DIVISIONS / 4, 'sixteenth': DIVISIONS / 4,
  };

  const noteTypeMap = {
    'w': 'whole', 'whole': 'whole', '1': 'whole',
    'h': 'half',  'half': 'half',  '2': 'half',
    'q': 'quarter', 'quarter': 'quarter', '4': 'quarter',
    '8': 'eighth',  'eighth': 'eighth',
    '16': '16th',   'sixteenth': '16th',
  };

  let noteXML = '';
  (notes || []).forEach(n => {
    const dur  = durationMap[n.duration] || DIVISIONS;
    const type = noteTypeMap[n.duration] || 'quarter';
    noteXML += `
      <note>
        <pitch><step>${n.pitch?.replace('#','').replace('b','') || 'C'}</step>
          ${n.pitch?.includes('#') ? '<alter>1</alter>' : ''}
          ${n.pitch?.includes('b') && n.pitch?.length > 1 ? '<alter>-1</alter>' : ''}
          <octave>${n.octave || 4}</octave>
        </pitch>
        <duration>${dur}</duration>
        <type>${type}</type>
      </note>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>ScoreShift Export — ${key}</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Music</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>${DIVISIONS}</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      ${noteXML}
    </measure>
  </part>
</score-partwise>`;
}

/* ============================================================
   섹션 표시
   ============================================================ */
function showSection(sectionId) {
  document.getElementById(sectionId)?.classList.remove('hidden');
  setTimeout(() => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

/* ============================================================
   전체 리셋
   ============================================================ */
function resetAll() {
  AppState.uploadedFile   = null;
  AppState.analysisData   = null;
  AppState.transposedData = null;
  AppState.selectedTargetKey = null;
  AppState.currentSemitones  = 0;

  resetUpload();

  ['analysis-section', 'transpose-section', 'output-section'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });

  document.getElementById('analysisResult')?.classList.add('hidden');
  document.getElementById('outputResult')?.classList.add('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });
  showToast('초기화되었습니다.', 'info');
}

/* ============================================================
   토스트 알림
   ============================================================ */
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <span class="toast-msg">${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

/* ============================================================
   유틸
   ============================================================ */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getKeyDescription(key, scale) {
  const majorDesc = {
    'C': '(C 장조, 플랫/샵 없음)', 'G': '(G 장조, 파♯)', 'D': '(D 장조, 파·도♯)',
    'A': '(A 장조, 파·도·솔♯)', 'E': '(E 장조, 4개 샵)', 'B': '(B 장조, 5개 샵)',
    'F': '(F 장조, 시♭)', 'Bb': '(B♭ 장조, 2개 플랫)', 'Eb': '(E♭ 장조, 3개 플랫)',
    'Ab': '(A♭ 장조, 4개 플랫)', 'Db': '(D♭ 장조, 5개 플랫)',
  };
  const minorDesc = {
    'A': '(가단조, 플랫/샵 없음)', 'E': '(마단조, 파♯)', 'D': '(라단조, 시♭)',
    'G': '(사단조, 시·미♭)', 'C': '(다단조, 3개 플랫)',
  };
  if (scale?.toLowerCase() === 'minor') return minorDesc[key] || `(${key} 단조)`;
  return majorDesc[key] || `(${key} 장조)`;
}
