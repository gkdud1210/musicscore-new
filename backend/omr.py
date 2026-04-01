"""
ScoreShift OMR (Optical Music Recognition) 엔진
OpenCV 기반 오선지 인식 및 음표 위치 감지
"""

import cv2
import numpy as np
import base64
import logging
from typing import List, Dict, Tuple, Optional

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════
#   높은음자리표(Treble) 오선 기준 음 매핑
#   오선 아래부터 위로: E4, G4, B4, D5, F5 (선 위)
#   오선 사이 간 위치: F4, A4, C5, E5
# ═══════════════════════════════════════════════════════════════

# 오선 밖까지 확장 (덧줄 포함)
# position: 0 = 첫째 줄(맨 아래), 0.5 = 첫째 칸, 1.0 = 둘째 줄 ...
TREBLE_EXTENDED = [
    (-3.0, 'F', 3),   # 아래 셋째 덧줄
    (-2.5, 'G', 3),
    (-2.0, 'A', 3),   # 아래 둘째 덧줄
    (-1.5, 'B', 3),
    (-1.0, 'C', 4),   # 아래 첫째 덧줄 = 가운데 도 (Middle C)
    (-0.5, 'D', 4),   # 첫째 줄 바로 아래 칸
    (0.0, 'E', 4),    # 첫째 줄
    (0.5, 'F', 4),    # 첫째 칸
    (1.0, 'G', 4),    # 둘째 줄
    (1.5, 'A', 4),    # 둘째 칸
    (2.0, 'B', 4),    # 셋째 줄
    (2.5, 'C', 5),    # 셋째 칸
    (3.0, 'D', 5),    # 넷째 줄
    (3.5, 'E', 5),    # 넷째 칸
    (4.0, 'F', 5),    # 다섯째 줄
    (4.5, 'G', 5),
    (5.0, 'A', 5),    # 위 첫째 덧줄
    (5.5, 'B', 5),
    (6.0, 'C', 6),    # 위 둘째 덧줄
    (6.5, 'D', 6),
    (7.0, 'E', 6),    # 위 셋째 덧줄
]

# 낮은음자리표: 첫째 줄 = G2, 다섯째 줄 = A3
BASS_EXTENDED = [
    (-3.0, 'A', 1),
    (-2.5, 'B', 1),
    (-2.0, 'C', 2),
    (-1.5, 'D', 2),
    (-1.0, 'E', 2),
    (-0.5, 'F', 2),
    (0.0, 'G', 2),   # 첫째 줄
    (0.5, 'A', 2),   # 첫째 칸
    (1.0, 'B', 2),   # 둘째 줄
    (1.5, 'C', 3),   # 둘째 칸
    (2.0, 'D', 3),   # 셋째 줄
    (2.5, 'E', 3),   # 셋째 칸
    (3.0, 'F', 3),   # 넷째 줄
    (3.5, 'G', 3),   # 넷째 칸
    (4.0, 'A', 3),   # 다섯째 줄
    (4.5, 'B', 3),
    (5.0, 'C', 4),
    (5.5, 'D', 4),
    (6.0, 'E', 4),
    (6.5, 'F', 4),
    (7.0, 'G', 4),
]


def preprocess_image(image_data: bytes) -> np.ndarray:
    """이미지 바이트 → OpenCV 이미지 (화질 개선 포함)"""
    nparr = np.frombuffer(image_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("이미지를 읽을 수 없습니다")

    # 화질 개선 파이프라인
    img = enhance_image(img)
    return img


def enhance_image(img: np.ndarray) -> np.ndarray:
    """악보 이미지 화질 개선"""
    h, w = img.shape[:2]

    # 1. 너무 작은 이미지는 확대 (최소 폭 1200px)
    if w < 1200:
        scale = 1200 / w
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        logger.info(f"이미지 확대: {w}x{h} → {img.shape[1]}x{img.shape[0]} (x{scale:.1f})")

    # 2. 노이즈 제거 (비국소 평균 필터 — 선은 유지하면서 노이즈만 제거)
    denoised = cv2.fastNlMeansDenoisingColored(img, None, 8, 8, 7, 21)

    # 3. 대비 강화 (CLAHE — 지역적 대비 개선)
    lab = cv2.cvtColor(denoised, cv2.COLOR_BGR2LAB)
    l_channel = lab[:, :, 0]
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    lab[:, :, 0] = clahe.apply(l_channel)
    enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    # 4. 선명화 (언샤프 마스크)
    gaussian = cv2.GaussianBlur(enhanced, (0, 0), 2.0)
    sharpened = cv2.addWeighted(enhanced, 1.5, gaussian, -0.5, 0)

    return sharpened


def to_grayscale(img: np.ndarray) -> np.ndarray:
    """그레이스케일 변환"""
    if len(img.shape) == 3:
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img


def to_python_types(obj):
    """numpy 타입을 Python 기본 타입으로 변환"""
    if isinstance(obj, dict):
        return {k: to_python_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [to_python_types(v) for v in obj]
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (np.floating,)):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj


def detect_staff_lines(img: np.ndarray) -> List[Dict]:
    """
    오선지 감지: 5개 수평선 그룹을 찾음
    Returns: [{"lines": [y1,y2,y3,y4,y5], "top": y1, "bottom": y5, "spacing": avg_gap}, ...]
    """
    gray = to_grayscale(img)
    h, w = gray.shape

    # 이진화 (적응형 임계) — blockSize를 이미지 크기에 비례하게
    block_size = max(15, min(51, w // 50)) | 1  # 홀수 보장
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block_size, 10
    )

    # 수평선 추출: 가로로 긴 커널로 모폴로지 연산
    # 오선은 이미지 폭의 상당 부분을 차지하므로 충분히 긴 커널 사용
    horizontal_kernel_size = max(w // 4, 50)
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (horizontal_kernel_size, 1))
    horizontal_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel)

    # 각 행의 흰 픽셀 밀도 계산 → 수평선 위치 찾기
    row_density = np.sum(horizontal_lines, axis=1) / (w * 255)

    # 밀도가 임계값 이상인 행 = 오선 후보
    threshold = 0.3
    line_rows = np.where(row_density > threshold)[0]

    if len(line_rows) == 0:
        logger.warning("오선을 감지하지 못했습니다. 임계값을 낮춥니다.")
        threshold = 0.15
        line_rows = np.where(row_density > threshold)[0]

    if len(line_rows) == 0:
        threshold = 0.08
        line_rows = np.where(row_density > threshold)[0]

    if len(line_rows) == 0:
        logger.warning("오선을 감지할 수 없습니다")
        return []

    # 연속된 행들을 하나의 선으로 그룹핑
    merged_lines = []
    start = line_rows[0]
    prev = line_rows[0]

    for r in line_rows[1:]:
        if r - prev > 3:  # 3px 이상 갭이면 새로운 선
            merged_lines.append((start + prev) // 2)  # 중간값
            start = r
        prev = r
    merged_lines.append((start + prev) // 2)

    logger.info(f"감지된 수평선: {len(merged_lines)}개")

    if len(merged_lines) < 5:
        logger.warning(f"오선을 구성하기에 선이 부족합니다 ({len(merged_lines)}개)")
        return []

    # 5개씩 그룹핑 (오선 단위)
    gaps = [merged_lines[i+1] - merged_lines[i] for i in range(len(merged_lines)-1)]

    if len(gaps) == 0:
        return []

    # 오선 내 줄 간격 추정: 가장 빈도 높은 간격 근처의 중간값
    sorted_gaps = sorted(gaps)
    # 하위 60%의 중간값 = 오선 내 간격 (오선 간 간격은 훨씬 크므로)
    staff_gap_candidates = sorted_gaps[:max(1, int(len(sorted_gaps) * 0.6))]
    median_gap = float(np.median(staff_gap_candidates))

    # 오선 내 간격 vs 오선 간 간격 구분
    staffs = []
    current_group = [merged_lines[0]]

    for i in range(1, len(merged_lines)):
        gap = merged_lines[i] - merged_lines[i-1]
        if gap > median_gap * 2.0:
            # 새로운 오선 그룹 시작
            if len(current_group) >= 5:
                staffs.append(current_group[:5])
            elif len(current_group) > 5:
                # 5개 초과면 간격이 가장 균일한 5개 선택
                staffs.append(current_group[:5])
            current_group = [merged_lines[i]]
        else:
            current_group.append(merged_lines[i])

    if len(current_group) >= 5:
        staffs.append(current_group[:5])

    # 결과 구성 — 오선 간격 균일성 검증
    result = []
    for lines in staffs:
        spacings = [lines[i+1] - lines[i] for i in range(len(lines)-1)]
        avg_spacing = sum(spacings) / len(spacings) if spacings else 10
        std_spacing = float(np.std(spacings)) if spacings else 0

        # 간격이 너무 불균일하면 오선이 아닐 수 있음
        if avg_spacing > 0 and std_spacing / avg_spacing > 0.5:
            logger.warning(f"오선 간격 불균일 (std/mean={std_spacing/avg_spacing:.2f}), 건너뜀")
            continue

        result.append({
            "lines": lines,
            "top": lines[0],
            "bottom": lines[-1],
            "spacing": avg_spacing,
        })

    logger.info(f"감지된 오선: {len(result)}개 (줄 간격: {result[0]['spacing']:.1f}px)" if result else "오선 없음")
    return result


def detect_note_heads(img: np.ndarray, staffs: List[Dict]) -> List[Dict]:
    """
    오선 위의 음표 머리(note head) 감지 — 타원 매칭 방식
    오선을 제거하지 않고 원본에서 직접 음표 머리 크기의 어두운 타원형 blob을 찾음.
    """
    gray = to_grayscale(img)
    img_h, img_w = gray.shape
    avg_spacing = np.mean([s["spacing"] for s in staffs])

    # ── 음표 머리 크기의 타원 커널로 매칭 (morphological hit-or-miss 대안) ──
    # 음표 머리는 가로 ~1.2*spacing, 세로 ~0.8*spacing 크기의 타원
    note_w = max(int(avg_spacing * 1.0), 5)
    note_h = max(int(avg_spacing * 0.7), 4)

    # 이진화
    block_size = max(15, min(51, img_w // 50)) | 1
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block_size, 10
    )

    # 방법 1: 타원 CLOSE로 음표 머리 크기의 blob만 남기기
    # 작은 것(오선, 줄기)은 사라지고 음표 머리 크기 이상만 남음
    ellipse_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (note_w, note_h)
    )
    # ERODE: 타원보다 작은 요소 제거 (오선 줄, 줄기 등)
    eroded = cv2.erode(binary, ellipse_kernel, iterations=1)
    # DILATE: 다시 복원하여 음표 머리 위치만 남김
    note_blobs = cv2.dilate(eroded, ellipse_kernel, iterations=1)

    # 방법 2: 더 작은 커널로 한 번 더 (놓친 작은 음표 잡기)
    small_w = max(int(avg_spacing * 0.7), 4)
    small_h = max(int(avg_spacing * 0.5), 3)
    small_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (small_w, small_h))
    eroded_small = cv2.erode(binary, small_kernel, iterations=1)
    note_blobs_small = cv2.dilate(eroded_small, small_kernel, iterations=1)

    # 두 결과 합침
    note_blobs = cv2.bitwise_or(note_blobs, note_blobs_small)

    # 오선 영역 마스크 — 오선 근처만
    staff_mask = np.zeros_like(note_blobs)
    for staff in staffs:
        margin = int(staff["spacing"] * 3.5)
        top = max(0, staff["top"] - margin)
        bottom = min(img_h, staff["bottom"] + margin)
        staff_mask[top:bottom, :] = 255
    note_blobs = cv2.bitwise_and(note_blobs, staff_mask)

    # 왼쪽 여백 제외 (음자리표 영역)
    clef_margin = int(img_w * 0.08)
    note_blobs[:, :clef_margin] = 0

    # 세로로 긴 요소 제거 (마디선이 남아있을 수 있음)
    stem_len = int(avg_spacing * 2.0)
    vert_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(stem_len, 15)))
    long_verts = cv2.morphologyEx(note_blobs, cv2.MORPH_OPEN, vert_kernel)
    note_blobs = cv2.subtract(note_blobs, long_verts)
    # 두꺼운 세로선도
    vert_kernel2 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, max(stem_len, 15)))
    long_verts2 = cv2.morphologyEx(note_blobs, cv2.MORPH_OPEN, vert_kernel2)
    note_blobs = cv2.subtract(note_blobs, long_verts2)

    # 컨투어 찾기
    contours, _ = cv2.findContours(note_blobs, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_dim = avg_spacing * 0.3
    max_dim = avg_spacing * 2.5

    note_heads = []
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        area = cv2.contourArea(cnt)

        # 크기 필터
        if cw < min_dim and ch < min_dim:
            continue
        if cw > max_dim or ch > max_dim:
            continue
        if area < min_dim * min_dim * 0.3:
            continue

        # 가로세로 비율 (0.4 ~ 2.5)
        aspect = cw / ch if ch > 0 else 0
        if aspect < 0.4 or aspect > 2.5:
            continue

        cx = x + cw // 2
        cy = y + ch // 2

        # 오선 소속 확인
        staff_idx = find_nearest_staff(cy, staffs)
        staff = staffs[staff_idx]
        margin = staff["spacing"] * 3.5
        if cy < staff["top"] - margin or cy > staff["bottom"] + margin:
            continue

        # 원본 이미지에서 해당 위치의 밝기로 채움 여부 판별
        pad = max(int(avg_spacing * 0.3), 2)
        ry1 = max(0, cy - pad)
        ry2 = min(img_h, cy + pad)
        rx1 = max(0, cx - pad)
        rx2 = min(img_w, cx + pad)
        roi = gray[ry1:ry2, rx1:rx2]
        mean_intensity = np.mean(roi) if roi.size > 0 else 128
        filled = mean_intensity < 160

        note_heads.append({
            "x": int(cx),
            "y": int(cy),
            "w": int(cw),
            "h": int(ch),
            "filled": filled,
            "staff_idx": staff_idx,
            "area": float(area),
        })

    # 중복 제거
    note_heads = merge_nearby_notes(note_heads, avg_spacing * 0.6)

    # X 좌표 기준 정렬
    note_heads.sort(key=lambda n: (n["staff_idx"], n["x"]))

    logger.info(f"감지된 음표 후보: {len(note_heads)}개")
    return note_heads


def merge_nearby_notes(note_heads: List[Dict], min_distance: float) -> List[Dict]:
    """너무 가까운 음표 머리를 병합"""
    if not note_heads:
        return note_heads

    merged = []
    used = set()

    for i, n1 in enumerate(note_heads):
        if i in used:
            continue
        group = [n1]
        for j, n2 in enumerate(note_heads):
            if j <= i or j in used:
                continue
            dist = np.sqrt((n1["x"] - n2["x"])**2 + (n1["y"] - n2["y"])**2)
            if dist < min_distance and n1["staff_idx"] == n2["staff_idx"]:
                group.append(n2)
                used.add(j)

        # 그룹 중 면적이 가장 큰 것 선택
        best = max(group, key=lambda n: n["area"])
        merged.append(best)

    return merged


def detect_notes_per_staff(img: np.ndarray, staffs: List[Dict]) -> List[Dict]:
    """
    각 오선 영역을 크롭 → 확대 → 정밀 분석하여 음표 감지.
    전체 이미지에서 한 번에 분석하는 것보다 정확도가 높음.
    """
    h, w = img.shape[:2]
    all_notes = []
    avg_spacing = np.mean([s["spacing"] for s in staffs])

    # 확대 목표: 오선 간격이 최소 20px이 되도록
    target_spacing = max(20, avg_spacing)
    scale = target_spacing / avg_spacing if avg_spacing < 20 else 1.0
    # 최대 3배 확대
    scale = min(scale, 3.0)
    # 이미 충분히 크면 확대하지 않음
    if avg_spacing >= 15:
        scale = 1.0

    for si, staff in enumerate(staffs):
        # 크롭 영역: 오선 위아래로 여유 (덧줄 + 줄기 포함)
        margin = int(staff["spacing"] * 4)
        crop_top = max(0, staff["top"] - margin)
        crop_bottom = min(h, staff["bottom"] + margin)
        crop = img[crop_top:crop_bottom, :]

        # 확대
        if scale > 1.0:
            crop_scaled = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            # 확대된 오선 정보 생성
            scaled_staff = {
                "lines": [int((ly - crop_top) * scale) for ly in staff["lines"]],
                "top": int((staff["top"] - crop_top) * scale),
                "bottom": int((staff["bottom"] - crop_top) * scale),
                "spacing": staff["spacing"] * scale,
            }
        else:
            crop_scaled = crop
            scaled_staff = {
                "lines": [ly - crop_top for ly in staff["lines"]],
                "top": staff["top"] - crop_top,
                "bottom": staff["bottom"] - crop_top,
                "spacing": staff["spacing"],
            }

        # 크롭된 이미지에서 음표 감지
        crop_notes = detect_note_heads(crop_scaled, [scaled_staff])

        # 좌표를 원본 이미지 기준으로 변환
        for note in crop_notes:
            note["x"] = int(note["x"] / scale) if scale > 1.0 else note["x"]
            note["y"] = int(note["y"] / scale + crop_top)
            note["w"] = int(note["w"] / scale) if scale > 1.0 else note["w"]
            note["h"] = int(note["h"] / scale) if scale > 1.0 else note["h"]
            note["staff_idx"] = si

        all_notes.extend(crop_notes)

    # 전체 중복 제거
    all_notes = merge_nearby_notes(all_notes, avg_spacing * 0.5)
    all_notes.sort(key=lambda n: (n["staff_idx"], n["x"]))

    logger.info(f"오선별 정밀 분석 완료: {len(all_notes)}개 음표 (확대 x{scale:.1f})")
    return all_notes


def find_nearest_staff(y: int, staffs: List[Dict]) -> int:
    """y 좌표가 어느 오선에 가장 가까운지"""
    min_dist = float('inf')
    best_idx = 0
    for i, staff in enumerate(staffs):
        center = (staff["top"] + staff["bottom"]) / 2
        dist = abs(y - center)
        if dist < min_dist:
            min_dist = dist
            best_idx = i
    return best_idx


def map_position_to_pitch(y: int, staff: Dict, clef: str = "treble") -> Tuple[str, int]:
    """
    음표의 y 좌표를 오선 위치 기반으로 음이름+옥타브로 변환

    position: 0 = 첫째 줄(맨 아래), 0.5 = 첫째 칸, 1.0 = 둘째 줄 ...
    인접한 오선 줄 사이 = 1.0, 줄과 칸 사이 = 0.5
    """
    lines = staff["lines"]
    spacing = staff["spacing"]

    # 오선 맨 아래줄 = 기준점 (position 0)
    # lines[0] = 맨 위줄 (y 작음), lines[-1] = 맨 아래줄 (y 큼)
    bottom_line = lines[-1]

    # y가 작을수록 높은 음 (화면 위 = 높은 음)
    # spacing = 인접한 두 줄 사이의 픽셀 거리 = position 1.0에 해당
    position = (bottom_line - y) / spacing

    # 가장 가까운 0.5 단위로 반올림
    position = round(position * 2) / 2

    # 음이름 매핑
    pitch_table = TREBLE_EXTENDED if clef == "treble" else BASS_EXTENDED

    # 가장 가까운 위치 찾기
    best_match = None
    min_dist = float('inf')
    for pos, pitch_name, octave in pitch_table:
        dist = abs(position - pos)
        if dist < min_dist:
            min_dist = dist
            best_match = (pitch_name, octave)

    if best_match:
        return best_match
    return ('C', 4)


def estimate_duration(note_head: Dict, avg_spacing: float) -> str:
    """음표 머리 특성으로 음길이 추정"""
    if not note_head["filled"]:
        if note_head["w"] > avg_spacing * 1.8:
            return "w"  # 온음표
        return "h"  # 2분음표
    else:
        return "q"  # 4분음표


def detect_barlines(img: np.ndarray, staffs: List[Dict], note_heads: List[Dict] = None) -> List[List[int]]:
    """
    세로 마디선(barline) 감지
    핵심 구분: 마디선은 오선 전체를 관통하고 근처에 음표 머리가 없음.
              줄기(stem)는 음표 머리에 연결되어 있음.
    Returns: staff별 마디선 x좌표 리스트
    """
    gray = to_grayscale(img)
    h, w = gray.shape

    block_size = max(15, min(51, w // 50)) | 1
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block_size, 10
    )

    barlines_per_staff = []

    for si, staff in enumerate(staffs):
        staff_height = staff["bottom"] - staff["top"]
        top = max(0, staff["top"] - 5)
        bottom = min(h, staff["bottom"] + 5)
        roi_height = bottom - top

        # 마디선은 오선 전체 높이의 85% 이상을 관통해야 함
        # (줄기는 보통 오선 높이의 50~70% 정도)
        min_barline_height = int(staff_height * 0.85)
        vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_barline_height))
        vertical_in_staff = cv2.morphologyEx(binary[top:bottom, :], cv2.MORPH_OPEN, vertical_kernel)

        col_density = np.sum(vertical_in_staff, axis=0) / (roi_height * 255)

        # 높은 밀도 = 마디선 후보 (75% 이상이 채워진 열)
        bar_threshold = 0.7
        bar_cols = np.where(col_density > bar_threshold)[0]

        # 연속된 열 그룹핑
        bar_candidates = []
        if len(bar_cols) > 0:
            start = bar_cols[0]
            prev = bar_cols[0]
            for c in bar_cols[1:]:
                if c - prev > 3:
                    bar_center = (start + prev) // 2
                    bar_width = prev - start
                    # 마디선은 매우 얇음 (4px 이내)
                    if bar_width <= max(4, staff["spacing"] * 0.3):
                        bar_candidates.append(bar_center)
                    start = c
                prev = c
            bar_center = (start + prev) // 2
            bar_width = prev - start
            if bar_width <= max(4, staff["spacing"] * 0.3):
                bar_candidates.append(bar_center)

        # 음자리표/끝선 영역 제거
        bars = [b for b in bar_candidates if w * 0.10 < b < w * 0.98]

        # ── 핵심: 줄기(stem)와 마디선 구분 ──
        # 음표 머리가 근처에 있는 세로선 = 줄기 → 제거
        if note_heads:
            staff_notes = [n for n in note_heads if n["staff_idx"] == si]
            confirmed_bars = []
            for bx in bars:
                is_stem = False
                for note in staff_notes:
                    # 음표 머리의 x좌표와 세로선의 x좌표가 가까우면 줄기
                    x_dist = abs(note["x"] - bx)
                    if x_dist < staff["spacing"] * 0.8:
                        is_stem = True
                        break
                if not is_stem:
                    confirmed_bars.append(bx)
            bars = confirmed_bars

        barlines_per_staff.append(bars)

    return barlines_per_staff


def assign_measures(note_heads: List[Dict], barlines_per_staff: List[List[int]], staffs: List[Dict]) -> List[Dict]:
    """음표에 마디 번호 부여"""
    for note in note_heads:
        si = note["staff_idx"]
        if si < len(barlines_per_staff):
            bars = barlines_per_staff[si]
            measure = 1
            for bx in bars:
                if note["x"] > bx:
                    measure += 1
            note["measure"] = measure
        else:
            note["measure"] = 1
    return note_heads


def create_annotated_image(img: np.ndarray, staffs: List[Dict],
                           note_heads: List[Dict], notes_data: List[Dict],
                           barlines: List[List[int]]) -> np.ndarray:
    """
    감지 결과를 원본 이미지 위에 오버레이
    """
    annotated = img.copy()
    h, w = annotated.shape[:2]

    # 반투명 오버레이용
    overlay = annotated.copy()

    # 1. 오선 영역 하이라이트
    for staff in staffs:
        top = staff["top"] - int(staff["spacing"] * 0.5)
        bottom = staff["bottom"] + int(staff["spacing"] * 0.5)
        cv2.rectangle(overlay, (0, max(0, top)), (w, min(h, bottom)),
                      (124, 107, 255), -1)  # 보라색 영역

    cv2.addWeighted(overlay, 0.08, annotated, 0.92, 0, annotated)

    # 2. 오선 줄 그리기 (파란색)
    for staff in staffs:
        for ly in staff["lines"]:
            cv2.line(annotated, (0, ly), (w, ly), (255, 180, 50), 1)

    # 3. 마디선 그리기 (초록색)
    for si, bars in enumerate(barlines):
        if si < len(staffs):
            staff = staffs[si]
            for bx in bars:
                cv2.line(annotated, (bx, staff["top"] - 5),
                         (bx, staff["bottom"] + 5), (50, 200, 50), 2)

    # 4. 감지된 음표 마킹
    SOLFEGE = {
        'C': '도', 'D': '레', 'E': '미', 'F': '파',
        'G': '솔', 'A': '라', 'B': '시',
    }

    for i, note in enumerate(note_heads):
        nx, ny = note["x"], note["y"]
        nw, nh = note["w"], note["h"]

        if i < len(notes_data):
            nd = notes_data[i]
            pitch = nd.get("pitch", "?")
            octave = nd.get("octave", "")
            solfege = SOLFEGE.get(pitch, pitch)
            label = f"{solfege}{octave}"
        else:
            label = "?"

        # 음표 원 (빨간 / 주황)
        color = (0, 100, 255) if note.get("filled") else (0, 180, 255)
        radius = max(int(nw * 0.6), 8)
        cv2.circle(annotated, (nx, ny), radius, color, 2)

        # 계이름 라벨
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.45
        thickness = 1
        (tw, th), _ = cv2.getTextSize(label, font, font_scale, thickness)

        label_y = ny - radius - 8
        if label_y < 15:
            label_y = ny + radius + th + 8

        # 라벨 배경
        pad = 3
        cv2.rectangle(annotated,
                      (nx - tw // 2 - pad, label_y - th - pad),
                      (nx + tw // 2 + pad, label_y + pad),
                      (20, 20, 40), -1)
        cv2.rectangle(annotated,
                      (nx - tw // 2 - pad, label_y - th - pad),
                      (nx + tw // 2 + pad, label_y + pad),
                      color, 1)

        cv2.putText(annotated, label,
                    (nx - tw // 2, label_y),
                    font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)

    # 5. 범례 추가
    legend_y = h - 60
    cv2.rectangle(annotated, (10, legend_y - 5), (350, h - 10), (20, 20, 40), -1)
    cv2.putText(annotated, "OMR Detection:", (15, legend_y + 15),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.circle(annotated, (180, legend_y + 12), 6, (255, 180, 50), 2)
    cv2.putText(annotated, "Staff", (190, legend_y + 16),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 180, 50), 1, cv2.LINE_AA)
    cv2.circle(annotated, (240, legend_y + 12), 6, (0, 100, 255), 2)
    cv2.putText(annotated, "Notes", (250, legend_y + 16),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 100, 255), 1, cv2.LINE_AA)
    cv2.line(annotated, (300, legend_y + 8), (300, legend_y + 18), (50, 200, 50), 2)
    cv2.putText(annotated, "Bar", (305, legend_y + 16),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (50, 200, 50), 1, cv2.LINE_AA)

    return annotated


def image_to_base64(img: np.ndarray) -> str:
    """OpenCV 이미지 → base64 문자열"""
    _, buffer = cv2.imencode('.png', img)
    return base64.b64encode(buffer).decode('utf-8')


# ═══════════════════════════════════════════════════════════════
#   메인 OMR 분석 함수
# ═══════════════════════════════════════════════════════════════

def analyze_with_omr(image_data: bytes, clef: str = "treble") -> dict:
    """
    오선지 인식 기반 악보 분석 (메인 진입점)
    """
    try:
        # 1. 이미지 로드
        img = preprocess_image(image_data)
        h, w = img.shape[:2]
        logger.info(f"OMR 분석 시작: {w}x{h}px")

        # 2. 오선 감지
        staffs = detect_staff_lines(img)
        if not staffs:
            return {
                "success": False,
                "error": "오선지를 감지하지 못했습니다. 악보 이미지가 맞는지 확인해주세요.",
                "staffs": [],
                "notes": [],
                "annotated_image": image_to_base64(img),
            }

        # 3. 오선별 크롭 → 확대 → 정밀 음표 감지
        note_heads = detect_notes_per_staff(img, staffs)

        # 4. 마디선 감지 (음표 위치를 참고하여 줄기와 구분)
        barlines = detect_barlines(img, staffs, note_heads)

        # 5. 마디 번호 부여
        note_heads = assign_measures(note_heads, barlines, staffs)

        # 6. 음이름 매핑
        avg_spacing = np.mean([s["spacing"] for s in staffs])
        notes_data = []
        for nh in note_heads:
            staff = staffs[nh["staff_idx"]]
            pitch_name, octave = map_position_to_pitch(nh["y"], staff, clef)
            duration = estimate_duration(nh, avg_spacing)

            notes_data.append({
                "pitch": pitch_name,
                "octave": octave,
                "duration": duration,
                "measure": nh.get("measure", 1),
                "beat": 1.0,
                "type": "note",
                "accidental": None,
                "position": {"x": nh["x"], "y": nh["y"]},
            })

        # 7. 마디별 beat 자동 계산
        measure_notes = {}
        for n in notes_data:
            m = n["measure"]
            if m not in measure_notes:
                measure_notes[m] = []
            measure_notes[m].append(n)

        for m, mnotes in measure_notes.items():
            beat = 1.0
            for n in mnotes:
                n["beat"] = beat
                dur_beats = {"w": 4, "h": 2, "q": 1, "8": 0.5, "16": 0.25}
                beat += dur_beats.get(n["duration"], 1)

        # 8. 주석 이미지 생성
        annotated = create_annotated_image(img, staffs, note_heads, notes_data, barlines)
        annotated_b64 = image_to_base64(annotated)

        # 9. 마디 수 계산
        total_measures = max([n.get("measure", 1) for n in notes_data]) if notes_data else 0

        # 10. 신뢰도 계산
        confidence = calculate_confidence(staffs, note_heads, notes_data, barlines)

        # 결과 요약
        staff_summary = []
        for i, s in enumerate(staffs):
            staff_summary.append({
                "index": i,
                "lines": s["lines"],
                "spacing": round(s["spacing"], 1),
                "note_count": sum(1 for n in note_heads if n["staff_idx"] == i),
            })

        result = {
            "success": True,
            "staffs": staff_summary,
            "notes": notes_data,
            "measures": total_measures,
            "annotated_image": annotated_b64,
            "detection_summary": {
                "staff_count": len(staffs),
                "note_count": len(notes_data),
                "measure_count": total_measures,
                "avg_staff_spacing": round(avg_spacing, 1),
                "image_size": {"width": w, "height": h},
                "barlines_per_staff": [len(b) for b in barlines],
            },
            "confidence": confidence,
        }

        logger.info(f"OMR 분석 완료: {len(staffs)}개 오선, {len(notes_data)}개 음표, {total_measures}개 마디")
        return to_python_types(result)

    except Exception as e:
        logger.error(f"OMR 분석 오류: {e}")
        return {
            "success": False,
            "error": f"OMR 분석 중 오류: {str(e)}",
            "staffs": [],
            "notes": [],
            "annotated_image": "",
        }


def calculate_confidence(staffs, note_heads, notes_data, barlines) -> float:
    """분석 신뢰도 계산 (0.0 ~ 1.0)"""
    score = 0.0

    # 오선 감지 여부 (30%)
    if len(staffs) > 0:
        score += 0.3
        # 오선 간격 균일성
        for s in staffs:
            spacings = [s["lines"][i+1] - s["lines"][i] for i in range(len(s["lines"])-1)]
            if spacings:
                std = np.std(spacings)
                mean = np.mean(spacings)
                uniformity = max(0, 1 - (std / mean)) if mean > 0 else 0
                score += 0.1 * uniformity / len(staffs)

    # 음표 감지 (30%)
    if len(note_heads) > 0:
        score += 0.2
        if 3 <= len(note_heads) <= 200:
            score += 0.1

    # 마디선 감지 (15%)
    if any(len(b) > 0 for b in barlines):
        score += 0.15

    # 음표가 오선 범위 안에 있는지 (15%)
    in_range = 0
    for nh in note_heads:
        si = nh["staff_idx"]
        if si < len(staffs):
            staff = staffs[si]
            margin = staff["spacing"] * 3
            if staff["top"] - margin <= nh["y"] <= staff["bottom"] + margin:
                in_range += 1
    if note_heads:
        score += 0.15 * (in_range / len(note_heads))

    return round(min(score, 1.0), 2)
