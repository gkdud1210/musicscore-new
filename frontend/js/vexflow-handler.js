/**
 * VexFlow Handler — 악보 렌더링 모듈
 * ScoreShift AI 악보 조 변환기
 */

const VF = Vex.Flow;

const SOLFEGE_LABEL = {
  'C': '도', 'D': '레', 'E': '미', 'F': '파',
  'G': '솔', 'A': '라', 'B': '시',
};

/**
 * 음표 데이터를 VexFlow로 렌더링 (여러 줄 자동 줄바꿈 + 계이름 표시)
 */
function renderScore(containerId, notes, keySignature = 'C', timeSignature = '4/4', options = {}) {
  const container = document.getElementById(containerId);
  if (!container) { console.error(`Container #${containerId} not found`); return; }
  container.innerHTML = '';

  const containerWidth = container.offsetWidth || 700;
  const opts = {
    staveWidth: containerWidth - 80,
    staveX: 40,
    staveYStart: 60,
    lineHeight: 120,
    clef: 'treble',
    showSolfege: true,
    ...options
  };

  // 마디별 그룹핑 (measure 필드 우선, 없으면 beat 기반)
  const [beatsPerMeasure] = timeSignature.split('/').map(Number);
  const measures = groupNotesByMeasureField(notes, beatsPerMeasure);
  const measuresCount = measures.length || 1;

  // 한 줄에 들어갈 마디 수 계산
  const firstMeasureExtra = 100; // 음자리표+조표+박자 공간
  const minMeasureWidth = 120;
  const availableWidth = opts.staveWidth - firstMeasureExtra;
  const maxMeasuresPerLine = Math.max(1, Math.floor(availableWidth / minMeasureWidth) + 1);
  // 첫 줄은 음자리표 때문에 하나 적게
  const measuresPerLine = Math.max(2, Math.min(maxMeasuresPerLine, 4));

  // 줄별로 마디 분배
  const lines = [];
  for (let i = 0; i < measuresCount; i += measuresPerLine) {
    lines.push(measures.slice(i, i + measuresPerLine));
  }

  const totalHeight = opts.staveYStart + lines.length * opts.lineHeight + 20;

  // SVG wrapper div
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  container.appendChild(wrapper);

  const renderer = new VF.Renderer(wrapper, VF.Renderer.Backends.SVG);
  renderer.resize(opts.staveWidth + 80, totalHeight);
  const context = renderer.getContext();
  context.setFont('Arial', 10);
  context.setFillStyle('#222');
  context.setStrokeStyle('#222');

  // 계이름 오버레이 컨테이너
  const solfegeOverlay = document.createElement('div');
  solfegeOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
  wrapper.appendChild(solfegeOverlay);

  // 각 줄 렌더링
  lines.forEach((lineMeasures, lineIdx) => {
    const isFirstLine = lineIdx === 0;
    const yOffset = opts.staveYStart + lineIdx * opts.lineHeight;

    // 마디별 폭 계산
    const extraWidth = isFirstLine ? firstMeasureExtra : 40;
    const measureWidth = Math.floor((opts.staveWidth - extraWidth) / lineMeasures.length);

    let xOffset = opts.staveX;

    lineMeasures.forEach((measureNotes, mIdx) => {
      const isFirstMeasure = isFirstLine && mIdx === 0;
      const staveW = isFirstMeasure ? measureWidth + firstMeasureExtra : measureWidth;

      const stave = new VF.Stave(xOffset, yOffset, staveW);

      if (isFirstMeasure) {
        stave.addClef(opts.clef);
        stave.addKeySignature(keySignature);
        stave.addTimeSignature(timeSignature);
      } else if (mIdx === 0 && !isFirstLine) {
        // 줄 시작에 음자리표만
        stave.addClef(opts.clef);
      }

      stave.setContext(context).draw();

      if (measureNotes.length > 0) {
        const vfNotes = measureNotes.map(n => createVFNote(n));
        const voice = new VF.Voice({
          num_beats: beatsPerMeasure,
          beat_value: parseInt(timeSignature.split('/')[1])
        }).setMode(VF.Voice.Mode.SOFT);

        voice.addTickables(vfNotes);

        const beams = VF.Beam.generateBeams(vfNotes);
        new VF.Formatter().joinVoices([voice]).format([voice], staveW - 40);

        voice.draw(context, stave);
        beams.forEach(b => b.setContext(context).draw());

        // 계이름 라벨 오버레이
        if (opts.showSolfege) {
          vfNotes.forEach((vfNote, ni) => {
            const noteData = measureNotes[ni];
            if (noteData.type === 'rest') return;

            const pitchBase = (noteData.pitch || '').replace('#', '').replace('b', '');
            const solfege = SOLFEGE_LABEL[pitchBase] || pitchBase;
            const accidental = noteData.pitch?.includes('#') ? '#' :
                               noteData.pitch?.includes('b') ? 'b' : '';

            try {
              const bbox = vfNote.getBoundingBox();
              if (!bbox) return;

              const labelX = bbox.getX() + bbox.getW() / 2;
              const labelY = yOffset - 2;

              const label = document.createElement('div');
              label.className = 'vf-solfege-label';
              label.innerHTML = `<span class="vf-sol-kr">${accidental}${solfege}</span><span class="vf-sol-en">${noteData.pitch}${noteData.octave || ''}</span>`;
              label.style.cssText = `position:absolute;left:${labelX}px;top:${labelY}px;transform:translateX(-50%);text-align:center;`;
              solfegeOverlay.appendChild(label);
            } catch(e) { /* 일부 음표에서 bbox 실패 가능 */ }
          });
        }
      } else {
        const rest = new VF.StaveNote({ keys: ['b/4'], duration: 'wr', type: 'r' });
        const voice = new VF.Voice({
          num_beats: beatsPerMeasure,
          beat_value: parseInt(timeSignature.split('/')[1])
        }).setMode(VF.Voice.Mode.SOFT);
        voice.addTickables([rest]);
        new VF.Formatter().joinVoices([voice]).format([voice], staveW - 40);
        voice.draw(context, stave);
      }

      xOffset += staveW;
    });
  });
}

/**
 * 음표를 measure 필드 기준으로 마디별 그룹핑
 */
function groupNotesByMeasureField(notes, beatsPerMeasure = 4) {
  if (!notes || notes.length === 0) return [[]];

  // measure 필드가 있는지 확인
  const hasMeasureField = notes.some(n => n.measure != null);

  if (hasMeasureField) {
    const measureMap = {};
    notes.forEach(n => {
      const m = n.measure || 1;
      if (!measureMap[m]) measureMap[m] = [];
      measureMap[m].push(n);
    });
    const measureNums = Object.keys(measureMap).map(Number).sort((a, b) => a - b);
    return measureNums.map(m => measureMap[m]);
  }

  // measure 필드 없으면 beat 기반 분할
  return groupNotesByMeasures(notes, beatsPerMeasure);
}

/**
 * 음표 1개를 VexFlow StaveNote로 변환
 */
function createVFNote(noteData) {
  const { pitch, octave, duration, type, accidental } = noteData;

  let vfKey;
  if (type === 'rest') {
    vfKey = 'b/4';
  } else {
    const basePitch = (pitch || 'C').replace('#', '').replace('b', '').toLowerCase();
    const oct = octave || 4;
    vfKey = `${basePitch}/${oct}`;
  }

  const vfDuration = durationToVF(duration);

  const note = new VF.StaveNote({
    keys: [vfKey],
    duration: type === 'rest' ? `${vfDuration}r` : vfDuration,
  });

  // Accidental 추가: pitch 자체에 포함되거나 accidental 필드에 있을 수 있음
  const acc = accidental || (pitch?.includes('#') ? '#' : pitch?.includes('b') && pitch?.length > 1 ? 'b' : null);
  if (acc === '#') note.addModifier(new VF.Accidental('#'), 0);
  else if (acc === 'b') note.addModifier(new VF.Accidental('b'), 0);
  else if (acc === 'n') note.addModifier(new VF.Accidental('n'), 0);

  return note;
}

/**
 * 음표 duration 문자열 → VexFlow duration 코드
 */
function durationToVF(duration) {
  const map = {
    'whole': 'w', 'half': 'h', 'quarter': 'q',
    'eighth': '8', 'sixteenth': '16',
    '1': 'w', '2': 'h', '4': 'q', '8': '8', '16': '16',
    'w': 'w', 'h': 'h', 'q': 'q',
  };
  return map[duration] || 'q';
}

/**
 * 음표 배열을 마디 단위로 그룹핑 (beat 기반 폴백)
 */
function groupNotesByMeasures(notes, beatsPerMeasure = 4) {
  if (!notes || notes.length === 0) return [[]];

  const durationBeats = {
    'w': 4, 'whole': 4, '1': 4,
    'h': 2, 'half': 2, '2': 2,
    'q': 1, 'quarter': 1, '4': 1,
    '8': 0.5, 'eighth': 0.5,
    '16': 0.25, 'sixteenth': 0.25,
  };

  const measures = [];
  let currentMeasure = [];
  let currentBeats = 0;

  notes.forEach(note => {
    const beats = durationBeats[note.duration] || 1;
    currentMeasure.push(note);
    currentBeats += beats;

    if (currentBeats >= beatsPerMeasure) {
      measures.push([...currentMeasure]);
      currentMeasure = [];
      currentBeats = 0;
    }
  });

  if (currentMeasure.length > 0) measures.push(currentMeasure);
  return measures;
}

/**
 * 히어로 섹션 데모 악보 렌더링
 */
function renderHeroDemo() {
  const demoContainer = document.getElementById('heroStaff');
  if (!demoContainer) return;

  const demoNotes = [
    { pitch: 'C', octave: 4, duration: 'q', measure: 1 },
    { pitch: 'E', octave: 4, duration: 'q', measure: 1 },
    { pitch: 'G', octave: 4, duration: 'q', measure: 1 },
    { pitch: 'C', octave: 5, duration: 'q', measure: 1 },
    { pitch: 'D', octave: 5, duration: 'h', measure: 2 },
    { pitch: 'B', octave: 4, duration: 'h', measure: 2 },
  ];

  try {
    renderScore('heroStaff', demoNotes, 'C', '4/4', { height: 140, showSolfege: false });
  } catch(e) {
    console.warn('Hero demo rendering failed:', e);
  }
}

/**
 * 악보를 SVG로 내보내기
 */
function exportScoreAsSVG(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  const svg = container.querySelector('svg');
  if (!svg) return null;
  return new XMLSerializer().serializeToString(svg);
}

/**
 * 악보를 PNG로 내보내기 (Canvas 변환)
 */
function exportScoreAsPNG(containerId, callback) {
  const svgStr = exportScoreAsSVG(containerId);
  if (!svgStr) { callback(null); return; }

  const canvas = document.createElement('canvas');
  const img = new Image();
  const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    canvas.width = img.width || 700;
    canvas.height = img.height || 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    callback(canvas.toDataURL('image/png'));
  };
  img.src = url;
}

// 페이지 로드 시 히어로 데모 렌더링
window.addEventListener('load', () => {
  setTimeout(renderHeroDemo, 300);
});
