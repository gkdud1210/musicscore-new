<?php
/**
 * 악보 라이브러리 API — 맥 버전 backend/library.py · extras.py 와 같은 주소·같은 답 모양.
 * 다른 점: PDF는 관리자 브라우저가 페이지 그림(JPEG)으로 바꿔 올리고, 서버는 그림만 저장한다.
 */

const SECTIONS = ['', 'before', 'after'];
const TEMPOS = ['', 'slow', 'fast'];
const STALE_UPLOAD_SECONDS = 900;   // 15분 동안 아무 진행이 없으면 끊긴 업로드로 본다
const LIVE_TTL_SECONDS = 6 * 3600;

const SONG_SELECT = "SELECT so.*, sc.title AS conti_title, sc.conti_date AS conti_date,
       k.score_id AS k_score_id, k.page_start AS k_page_start, k.page_end AS k_page_end
    FROM songs so JOIN scores sc ON sc.id = so.score_id
    LEFT JOIN songs k ON k.id = so.use_song_id";

// ── 변환 ─────────────────────────────────────────────────────
function image_urls(int $scoreId, int $start, int $end): array
{
    $out = [];
    for ($n = $start; $n <= $end; $n++) $out[] = "/api/scores/$scoreId/pages/$n/image";
    return $out;
}

function song_from_row(array $r, ?array $sheetOf = null): array
{
    $sheetOf ??= sheet_of_map();
    $alias = ($r['use_song_id'] !== null && $r['k_score_id'] !== null) ? (int)$r['use_song_id'] : null;
    [$is, $ia, $ib] = $alias ? [(int)$r['k_score_id'], (int)$r['k_page_start'], (int)$r['k_page_end']]
                             : [(int)$r['score_id'], (int)$r['page_start'], (int)$r['page_end']];
    $lyrics = str_replace("\n", ' ', (string)$r['lyrics_text']);
    return [
        'id' => (int)$r['id'],
        'title' => $r['title'],
        'key' => $r['song_key'],
        'key_source' => $r['key_source'],
        'chords' => array_values(array_filter(explode(' ', (string)$r['chords_text']), 'strlen')),
        'score_id' => (int)$r['score_id'],
        'conti_title' => $r['conti_title'],
        'conti_date' => $r['conti_date'],
        'page_start' => (int)$r['page_start'],
        'page_end' => (int)$r['page_end'],
        'image_urls' => image_urls($is, $ia, $ib),
        'lyrics_snippet' => mb_substr($lyrics, 0, 120),
        'sheet_id' => $alias ? ($sheetOf[$alias] ?? $alias) : ($sheetOf[$r['id']] ?? (int)$r['id']),
        'section' => $r['section'],
        'tempo' => $r['tempo'],
        'matched' => $r['matched_from'] !== null,
        'use_song_id' => $alias,
    ];
}

function song_brief(array $r): array
{
    return [
        'id' => (int)$r['id'], 'title' => $r['title'], 'key' => $r['song_key'], 'key_source' => $r['key_source'],
        'page_start' => (int)$r['page_start'], 'page_end' => (int)$r['page_end'],
        'section' => $r['section'], 'tempo' => $r['tempo'], 'matched' => $r['matched_from'] !== null,
        'use_song_id' => $r['use_song_id'] !== null ? (int)$r['use_song_id'] : null,
    ];
}

function score_row(int $id): array
{
    $r = q_one('SELECT * FROM scores WHERE id = ?', [$id]);
    if (!$r) throw new ApiError(404, '콘티를 찾을 수 없습니다');
    return $r;
}

function score_summary(array $row, bool $detail = false): array
{
    $id = (int)$row['id'];
    $status = $row['status'];
    $statusDetail = $row['status_detail'];
    if ($status === 'processing' && time() - strtotime($row['updated_at']) > STALE_UPLOAD_SECONDS) {
        $status = 'error';
        $statusDetail = '올리기/읽기가 중간에 멈췄어요. "처음부터 다시 분석"을 누르거나, 지우고 다시 올려주세요';
    }
    $overlaps = [];
    foreach (overlaps_for($id) as $o) {
        $r = q_one('SELECT title, conti_date, page_count FROM scores WHERE id = ?', [$o['id']]);
        if ($r) $overlaps[] = $o + ['title' => $r['title'], 'conti_date' => $r['conti_date'], 'page_count' => (int)$r['page_count']];
    }
    $chords = array_values(array_filter(explode(' ', (string)$row['chords_text']), 'strlen'));
    sort($chords);
    $out = [
        'id' => $id,
        'title' => $row['title'],
        'page_count' => (int)$row['page_count'],
        'chords' => $chords,
        'thumbnail_url' => "/api/scores/$id/thumbnail",
        'created_at' => $row['created_at'],
        'updated_at' => $row['updated_at'],
        'conti_date' => $row['conti_date'],
        'original_filename' => $row['original_filename'],
        'songs' => array_map('song_brief', q_all('SELECT * FROM songs WHERE score_id = ? ORDER BY page_start', [$id])),
        'duplicate' => false,
        'confirmed' => (bool)$row['confirmed'],
        'status' => $status,
        'status_detail' => $statusDetail,
        'overlaps' => $overlaps,
    ];
    if ($detail) $out['lyrics_text'] = (string)$row['lyrics_text'];
    return $out;
}

function summary_by_id(int $id, bool $detail = false): array { return score_summary(score_row($id), $detail); }

function get_song_row(int $id): array
{
    $r = q_one(SONG_SELECT . ' WHERE so.id = ?', [$id]);
    if (!$r) throw new ApiError(404, '곡을 찾을 수 없습니다');
    return $r;
}

function page_dicts(int $scoreId, int $start, int $end): array
{
    $out = [];
    foreach (q_all('SELECT * FROM pages WHERE score_id = ? AND page_number BETWEEN ? AND ? ORDER BY page_number', [$scoreId, $start, $end]) as $r) {
        $out[] = [
            'page_number' => (int)$r['page_number'],
            'title_guess' => $r['title_guess'],
            'has_title' => (bool)$r['has_title'],
            'key_explicit' => (string)$r['key_explicit'],
            'chords' => json_decode((string)($r['chords_json'] ?: '[]'), true) ?: [],
            'lyrics_text' => (string)$r['lyrics_text'],
        ];
    }
    return $out;
}

function recompute_song(int $songId): void
{
    $s = q_one('SELECT * FROM songs WHERE id = ?', [$songId]);
    if (!$s) return;
    $pages = page_dicts((int)$s['score_id'], (int)$s['page_start'], (int)$s['page_end']);
    if (!$pages) return;
    $meta = build_song_meta($pages);
    $title = $s['title_manual'] ? $s['title'] : $meta['title'];
    [$key, $src] = $s['key_source'] === 'manual' ? [$s['song_key'], $s['key_source']] : [$meta['song_key'], $meta['key_source']];
    q('UPDATE songs SET title = ?, song_key = ?, key_source = ?, lyrics_text = ?, chords_text = ? WHERE id = ?',
      [mb_substr($title, 0, 250), $key, $src, $meta['lyrics_text'], implode(' ', $meta['chords']), $songId]);
}

function insert_song(int $scoreId, int $start, int $end): int
{
    q('INSERT INTO songs (score_id, page_start, page_end) VALUES (?, ?, ?)', [$scoreId, $start, $end]);
    $id = (int)db()->lastInsertId();
    recompute_song($id);
    return $id;
}

function touch_score(int $id, ?string $status = null, ?string $detail = null): void
{
    if ($status !== null) {
        q('UPDATE scores SET status = ?, status_detail = ?, updated_at = NOW() WHERE id = ?', [$status, mb_substr((string)$detail, 0, 300), $id]);
    } else {
        q('UPDATE scores SET updated_at = NOW() WHERE id = ?', [$id]);
    }
}

// ── 콘티 목록 / 상세 / 수정 / 삭제 ───────────────────────────
function api_list_scores(): array
{
    $where = [];
    $params = [];
    $qq = trim((string)($_GET['q'] ?? ''));
    if ($qq !== '') {
        $where[] = '(title LIKE ? OR original_filename LIKE ? OR id IN (SELECT score_id FROM songs WHERE title LIKE ?))';
        $params = array_fill(0, 3, "%$qq%");
    }
    if (current_role() !== 'admin') $where[] = 'confirmed = 1';
    $sql = 'SELECT * FROM scores' . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
         . ' ORDER BY confirmed, (conti_date IS NULL), conti_date DESC, created_at DESC';
    return array_map('score_summary', q_all($sql, $params));
}

function api_update_score(int $id): array
{
    score_row($id);
    $b = body_json();
    if (array_key_exists('title', $b) && $b['title'] !== null) {
        q('UPDATE scores SET title = ?, updated_at = NOW() WHERE id = ?', [mb_substr(trim((string)$b['title']), 0, 250) ?: '제목 없는 콘티', $id]);
    }
    if (array_key_exists('conti_date', $b) && $b['conti_date'] !== null) {
        $d = trim((string)$b['conti_date']);
        q('UPDATE scores SET conti_date = ?, updated_at = NOW() WHERE id = ?', [$d === '' ? null : mb_substr($d, 0, 10), $id]);
    }
    if (isset($b['chords']) && is_array($b['chords'])) {
        $cs = array_unique(array_filter(array_map('trim', array_map('strval', $b['chords'])), 'strlen'));
        sort($cs);
        q('UPDATE scores SET chords_text = ? WHERE id = ?', [implode(' ', $cs), $id]);
    }
    return summary_by_id($id);
}

function api_confirm_score(int $id): array
{
    score_row($id);
    $b = body_json();
    q('UPDATE scores SET confirmed = ?, updated_at = NOW() WHERE id = ?', [array_key_exists('confirmed', $b) ? (int)(bool)$b['confirmed'] : 1, $id]);
    return summary_by_id($id);
}

function api_delete_score(int $id): array
{
    score_row($id);
    q('DELETE FROM scores WHERE id = ?', [$id]);
    rrmdir(DATA_DIR . "/scores/$id");
    return ['success' => true];
}

// ── 올리기: 브라우저가 PDF → 페이지 그림으로 바꿔서 한 장씩 ─────
function api_create_score(): array
{
    $b = body_json();
    $filename = trim((string)($b['filename'] ?? '')) ?: 'conti.pdf';
    $pageCount = (int)($b['page_count'] ?? 0);
    $hash = strtolower(trim((string)($b['file_hash'] ?? '')));
    if ($pageCount < 1 || $pageCount > 300) throw new ApiError(400, '페이지 수가 잘못됐어요');
    if ($hash !== '' && !preg_match('/^[0-9a-f]{64}$/', $hash)) $hash = '';
    if ($hash !== '') {
        $ex = q_one('SELECT * FROM scores WHERE file_hash = ?', [$hash]);
        if ($ex) return ['duplicate' => true] + score_summary($ex);
    }
    $stem = preg_replace('/\.(pdf|jpe?g|png|heic|heif|webp|gif)$/i', '', basename($filename));
    q("INSERT INTO scores (title, original_filename, page_count, conti_date, file_hash, confirmed, status, status_detail)
       VALUES (?, ?, ?, ?, ?, 0, 'processing', '올리는 중')",
      [mb_substr($stem, 0, 250), mb_substr($filename, 0, 250), $pageCount, guess_date($stem), $hash ?: null]);
    $id = (int)db()->lastInsertId();
    score_dir($id);
    return summary_by_id($id);
}

function save_uploaded_jpeg(string $field, string $dest, int $maxBytes): void
{
    $f = $_FILES[$field] ?? null;
    if (!$f || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) throw new ApiError(400, '그림 파일이 안 왔어요');
    if ($f['size'] > $maxBytes) throw new ApiError(400, '그림이 너무 커요');
    $info = @getimagesize($f['tmp_name']);
    if (!$info || $info[2] !== IMAGETYPE_JPEG) throw new ApiError(400, 'JPEG 그림만 받아요');
    if (!move_uploaded_file($f['tmp_name'], $dest)) {
        if (!@rename($f['tmp_name'], $dest)) throw new ApiError(500, '그림을 저장하지 못했어요 (data 폴더 쓰기 권한 확인)');
    }
    @chmod($dest, 0644);
}

function api_upload_page(int $id, int $n): array
{
    $s = score_row($id);
    if ($n < 1 || $n > (int)$s['page_count']) throw new ApiError(400, '페이지 번호가 잘못됐어요');
    score_dir($id);
    $path = page_file($id, $n);
    save_uploaded_jpeg('image', $path, 8 * 1024 * 1024);
    if (!empty($_FILES['thumb'])) save_uploaded_jpeg('thumb', thumb_file($id), 2 * 1024 * 1024);
    $h = page_hash_file($path);
    $w = (float)($_POST['width'] ?? 595);
    $hh = (float)($_POST['height'] ?? 842);
    q('INSERT INTO pages (score_id, page_number, width, height, h, analyzed) VALUES (?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE width = VALUES(width), height = VALUES(height), h = VALUES(h), analyzed = 0',
      [$id, $n, $w > 0 ? $w : 595, $hh > 0 ? $hh : 842, $h]);
    touch_score($id, 'processing', "올리는 중 $n/{$s['page_count']}쪽");
    return ['page_number' => $n, 'ok' => true];
}

function store_page_result(int $id, array $p): void
{
    q('UPDATE pages SET analyzed = 1, title_guess = ?, has_title = ?, key_explicit = ?, chords_json = ?, lyrics_text = ?
       WHERE score_id = ? AND page_number = ?',
      [$p['title_guess'], (int)$p['has_title'], (string)$p['key_explicit'],
       json_encode($p['chords'], JSON_UNESCAPED_UNICODE), (string)$p['lyrics_text'], $id, $p['page_number']]);
}

/** 페이지 한 장 읽기: 전에 읽은 같은 악보면 그 결과를, 아니면 제미나이로 */
function api_read_page(int $id, int $n): array
{
    @set_time_limit(150);
    $s = score_row($id);
    $page = q_one('SELECT * FROM pages WHERE score_id = ? AND page_number = ?', [$id, $n]);
    if (!$page || !is_file(page_file($id, $n))) throw new ApiError(400, "{$n}쪽 그림이 아직 안 올라왔어요");
    $reuse = !empty(body_json()['reuse']);
    if ($reuse && $page['h']) {
        $ref = reference_page($id, $page['h']);
        if ($ref) {
            store_page_result($id, [
                'page_number' => $n, 'title_guess' => $ref['title_guess'], 'has_title' => (bool)$ref['has_title'],
                'key_explicit' => $ref['key_explicit'], 'chords' => json_decode((string)($ref['chords_json'] ?: '[]'), true) ?: [],
                'lyrics_text' => $ref['lyrics_text'],
            ]);
            touch_score($id, 'processing', "읽는 중 $n/{$s['page_count']}쪽");
            return ['page_number' => $n, 'reused' => true];
        }
    }
    touch_score($id, 'processing', "제미나이 인식 $n/{$s['page_count']}쪽");
    $p = gemini_read_page(page_file($id, $n), $n, (int)$s['page_count']);
    store_page_result($id, $p);
    touch_score($id);
    return ['page_number' => $n, 'reused' => false, 'title' => $p['title_guess']];
}

/** 모든 페이지를 읽었으면 곡으로 나눠 저장 (맥 버전 _analyze_and_store) */
function api_finish_score(int $id): array
{
    $s = score_row($id);
    $count = (int)$s['page_count'];
    $rows = q_all('SELECT * FROM pages WHERE score_id = ? ORDER BY page_number', [$id]);
    $missing = [];
    $byN = [];
    foreach ($rows as $r) $byN[(int)$r['page_number']] = $r;
    for ($n = 1; $n <= $count; $n++) {
        if (empty($byN[$n]['analyzed'])) $missing[] = $n;
    }
    if ($missing && !empty(body_json()['allow_unread'])) {
        // 사진 업로드: AI가 못 읽은 장은 '제목 없음' 곡 하나씩으로 두고, 사람이 제목·키를 적는다
        foreach ($missing as $n) {
            store_page_result($id, ['page_number' => $n, 'title_guess' => '', 'has_title' => true, 'key_explicit' => '',
                                    'chords' => [], 'lyrics_text' => '']);
            $byN[$n]['analyzed'] = 1;
        }
        $missing = [];
    }
    if ($missing) throw new ApiError(400, '아직 안 읽은 페이지가 있어요: ' . implode(', ', array_slice($missing, 0, 10)) . '쪽');
    $pages = page_dicts($id, 1, $count);
    $hashes = [];
    foreach ($byN as $n => $r) $hashes[$n] = $r['h'];
    $forced = reference_songs($id, $hashes);

    db()->beginTransaction();
    try {
        q('DELETE FROM songs WHERE score_id = ?', [$id]);
        foreach (merge_segments(segment_songs($pages), $forced) as [$a, $b, $src]) {
            $sid = insert_song($id, $a, $b);
            if ($src) {
                q('UPDATE songs SET title = ?, title_manual = 1, song_key = ?, key_source = ?, tempo = ?, matched_from = ?, use_song_id = ? WHERE id = ?',
                  [$src['title'], $src['song_key'], $src['key_source'] ?: 'manual', $src['tempo'], $src['id'], $src['use_song_id'], $sid]);
            }
        }
        $allChords = [];
        $lyrics = [];
        foreach ($pages as $p) { foreach ($p['chords'] as $c) $allChords[$c] = true; $lyrics[] = $p['lyrics_text']; }
        $cs = array_keys($allChords);
        sort($cs);
        q('UPDATE scores SET chords_text = ?, lyrics_text = ?, status = ?, status_detail = ?, updated_at = NOW() WHERE id = ?',
          [implode(' ', $cs), implode("\n", $lyrics), 'ready', '', $id]);
        if (!empty(body_json()['first_upload']) && !$s['conti_date'] && $pages) {
            $d = guess_date(($pages[0]['title_guess'] ?? '') . "\n" . $pages[0]['lyrics_text']);
            if ($d) q('UPDATE scores SET conti_date = ? WHERE id = ?', [$d, $id]);
        }
        db()->commit();
    } catch (Throwable $e) {
        db()->rollBack();
        throw $e;
    }
    return summary_by_id($id);
}

/** 읽기가 실패했을 때: 콘티는 남기고, 곡이 하나도 없으면 페이지마다 곡 1개로 (손으로 고칠 수 있게) */
function api_fail_score(int $id): array
{
    $s = score_row($id);
    $detail = mb_substr(trim((string)(body_json()['detail'] ?? '')) ?: '분석 실패', 0, 280);
    if (!q_val('SELECT 1 FROM songs WHERE score_id = ? LIMIT 1', [$id])) {
        foreach (q_all('SELECT page_number FROM pages WHERE score_id = ? ORDER BY page_number', [$id]) as $p) {
            q('INSERT INTO songs (score_id, page_start, page_end) VALUES (?, ?, ?)', [$id, $p['page_number'], $p['page_number']]);
        }
    }
    touch_score($id, 'error', $detail);
    return summary_by_id($id);
}

function api_reprocess_score(int $id): array
{
    $s = score_row($id);
    if ($s['status'] === 'processing' && time() - strtotime($s['updated_at']) < 120) {
        throw new ApiError(409, '이미 분석 중이에요. 끝날 때까지 기다려주세요');
    }
    if (!gemini_available()) throw new ApiError(400, '제미나이 API 키가 없어서 다시 읽을 수 없어요 (config.php)');
    $have = (int)q_val('SELECT COUNT(*) FROM pages WHERE score_id = ?', [$id]);
    if ($have < (int)$s['page_count']) {
        throw new ApiError(400, '페이지 그림이 다 올라오지 않은 콘티예요. 지우고 PDF를 다시 올려주세요');
    }
    touch_score($id, 'processing', '다시 읽는 중');
    return summary_by_id($id);
}

function api_ai_status(): array
{
    return ['available' => false, 'gemini' => gemini_available(), 'engine' => 'gemini', 'client_render' => true];
}

// ── 곡 검색 / 수정 ───────────────────────────────────────────
function api_search_songs(): array
{
    $where = [];
    $params = [];
    $section = $_GET['section'] ?? '';
    $tempo = $_GET['tempo'] ?? '';
    if (in_array($section, ['before', 'after'], true)) { $where[] = 'so.section = ?'; $params[] = $section; }
    if (in_array($tempo, ['slow', 'fast'], true)) { $where[] = 'so.tempo = ?'; $params[] = $tempo; }
    $qq = trim((string)($_GET['q'] ?? ''));
    if ($qq !== '') {
        $nq = '%' . mb_strtolower(preg_replace('/\s+/u', '', $qq)) . '%';
        $where[] = "(LOWER(REPLACE(REPLACE(so.title, ' ', ''), CHAR(10), '')) LIKE ? OR LOWER(REPLACE(REPLACE(COALESCE(so.lyrics_text, ''), ' ', ''), CHAR(10), '')) LIKE ?)";
        $params[] = $nq;
        $params[] = $nq;
    }
    if (!empty($_GET['key'])) {
        $keys = array_values(array_filter(array_map('normalize_key', explode(',', (string)$_GET['key'])), 'strlen'));
        if ($keys) { $where[] = 'so.song_key IN (' . marks_sql($keys) . ')'; array_push($params, ...$keys); }
    }
    if (!empty($_GET['chords'])) {
        foreach (array_filter(array_map('trim', explode(',', (string)$_GET['chords'])), 'strlen') as $c) {
            $where[] = "CONCAT(' ', COALESCE(so.chords_text, ''), ' ') LIKE ?";
            $params[] = "% $c %";
        }
    }
    if (isset($_GET['score_id']) && $_GET['score_id'] !== '') {
        $where[] = 'so.score_id = ?';
        $params[] = (int)$_GET['score_id'];
    } else {
        $where[] = 'sc.confirmed = 1';
    }
    $sql = SONG_SELECT . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
         . ' ORDER BY so.title, (sc.conti_date IS NULL), sc.conti_date DESC, so.id DESC';
    $sheetOf = sheet_of_map();
    return array_map(fn($r) => song_from_row($r, $sheetOf), q_all($sql, $params));
}

function api_song_facets(): array
{
    $ok = 'score_id IN (SELECT id FROM scores WHERE confirmed = 1)';
    $keys = array_map(fn($r) => ['key' => $r['song_key'], 'count' => (int)$r['n']],
        q_all("SELECT song_key, COUNT(*) AS n FROM songs WHERE song_key != '' AND $ok GROUP BY song_key"));
    $chordSet = [];
    foreach (q_all("SELECT chords_text FROM songs WHERE $ok") as $r) {
        foreach (explode(' ', (string)$r['chords_text']) as $c) if ($c !== '') $chordSet[$c] = true;
    }
    $chords = array_keys($chordSet);
    sort($chords);
    $cats = [];
    foreach ([['section', 'before'], ['section', 'after'], ['tempo', 'slow'], ['tempo', 'fast']] as [$col, $val]) {
        $cats[$val] = (int)q_val("SELECT COUNT(DISTINCT LOWER(REPLACE(title, ' ', ''))) FROM songs WHERE $col = ? AND $ok", [$val]);
    }
    return ['keys' => $keys, 'chords' => $chords, 'total' => (int)q_val("SELECT COUNT(*) FROM songs WHERE $ok"), 'categories' => $cats];
}

function api_get_song(int $id): array { return song_from_row(get_song_row($id)); }

/** 제목·키·빠르기를 같이 바꿀 곡들: 같은 그림의 악보 + 하나만 남긴 악보로 묶인 곡들 */
function linked_song_ids(int $songId): array
{
    $use = q_val('SELECT use_song_id FROM songs WHERE id = ?', [$songId]);
    $roots = same_sheet_song_ids($songId);
    if ($use) $roots = array_merge($roots, same_sheet_song_ids((int)$use));
    $roots = array_values(array_unique(array_map('intval', $roots)));
    $ids = $roots;
    foreach (q_all('SELECT id FROM songs WHERE use_song_id IN (' . marks_sql($roots) . ')', $roots) as $r) $ids[] = (int)$r['id'];
    $ids = array_values(array_unique($ids));
    sort($ids);
    return $ids;
}

function api_update_song(int $id): array
{
    $b = body_json();
    if (isset($b['section']) && !in_array($b['section'], SECTIONS, true)) throw new ApiError(400, "section 은 before / after / '' 중 하나");
    if (isset($b['tempo']) && !in_array($b['tempo'], TEMPOS, true)) throw new ApiError(400, "tempo 는 slow / fast / '' 중 하나");
    $old = get_song_row($id);
    $same = linked_song_ids($id);
    $m = marks_sql($same);
    if (isset($b['title']) && trim((string)$b['title']) !== $old['title']) {
        q("UPDATE songs SET title = ?, title_manual = 1 WHERE id IN ($m)", [mb_substr(trim((string)$b['title']), 0, 250) ?: '제목 없음', ...$same]);
    }
    if (isset($b['key']) && normalize_key((string)$b['key']) !== $old['song_key']) {
        $k = mb_substr(normalize_key((string)$b['key']), 0, 16);
        q("UPDATE songs SET song_key = ?, key_source = ? WHERE id IN ($m)", [$k, $k !== '' ? 'manual' : '', ...$same]);
    }
    if (isset($b['tempo']) && $b['tempo'] !== $old['tempo']) {
        q("UPDATE songs SET tempo = ? WHERE id IN ($m)", [$b['tempo'], ...$same]);
    }
    if (isset($b['section'])) q('UPDATE songs SET section = ? WHERE id = ?', [$b['section'], $id]);
    return song_from_row(get_song_row($id));
}

function api_delete_song(int $id): array
{
    get_song_row($id);
    q('DELETE FROM songs WHERE id = ?', [$id]);
    return ['success' => true];
}

function api_merge_prev(int $id): array
{
    $s = get_song_row($id);
    $prev = q_one('SELECT * FROM songs WHERE score_id = ? AND page_start < ? ORDER BY page_start DESC LIMIT 1', [$s['score_id'], $s['page_start']]);
    if (!$prev) throw new ApiError(400, '앞에 합칠 곡이 없습니다');
    q('UPDATE songs SET page_end = ? WHERE id = ?', [max((int)$prev['page_end'], (int)$s['page_end']), $prev['id']]);
    q('DELETE FROM songs WHERE id = ?', [$id]);
    recompute_song((int)$prev['id']);
    return summary_by_id((int)$s['score_id']);
}

function api_split_song(int $id): array
{
    $s = get_song_row($id);
    $p = (int)(body_json()['page'] ?? 0);
    if (!($s['page_start'] < $p && $p <= $s['page_end'])) throw new ApiError(400, '나눌 페이지가 곡 범위 밖입니다');
    q('UPDATE songs SET page_end = ? WHERE id = ?', [$p - 1, $id]);
    recompute_song($id);
    $new = insert_song((int)$s['score_id'], $p, (int)$s['page_end']);
    q('UPDATE songs SET section = ? WHERE id = ?', [$s['section'], $new]);
    return summary_by_id((int)$s['score_id']);
}

function api_remove_page(int $id): array
{
    $s = get_song_row($id);
    $p = (int)(body_json()['page'] ?? 0);
    [$a, $b] = [(int)$s['page_start'], (int)$s['page_end']];
    if ($p < $a || $p > $b) throw new ApiError(400, '곡 범위 밖의 페이지입니다');
    if ($a === $b) {
        q('DELETE FROM songs WHERE id = ?', [$id]);
    } elseif ($p === $a) {
        q('UPDATE songs SET page_start = ? WHERE id = ?', [$p + 1, $id]);
        recompute_song($id);
    } elseif ($p === $b) {
        q('UPDATE songs SET page_end = ? WHERE id = ?', [$p - 1, $id]);
        recompute_song($id);
    } else {
        q('UPDATE songs SET page_end = ? WHERE id = ?', [$p - 1, $id]);
        recompute_song($id);
        insert_song((int)$s['score_id'], $p + 1, $b);
    }
    return summary_by_id((int)$s['score_id']);
}

function api_add_song(int $scoreId): array
{
    $row = score_row($scoreId);
    $b = body_json();
    $a = (int)($b['page_start'] ?? 0);
    $e = (int)($b['page_end'] ?? 0);
    if (!(1 <= $a && $a <= $e && $e <= (int)$row['page_count'])) throw new ApiError(400, '페이지 범위가 잘못됐습니다');
    if (q_val('SELECT 1 FROM songs WHERE score_id = ? AND page_start <= ? AND page_end >= ?', [$scoreId, $e, $a])) {
        throw new ApiError(400, '이미 다른 곡에 속한 페이지입니다');
    }
    insert_song($scoreId, $a, $e);
    return summary_by_id($scoreId);
}

/** 같은 제목·키 악보가 여러 장일 때 이 악보만 남긴다 */
function api_keep_sheet(int $keepId): array
{
    $keep = get_song_row($keepId);
    $keepSheet = array_map('intval', same_sheet_song_ids($keepId));
    $targets = [];
    foreach ((array)(body_json()['song_ids'] ?? []) as $sid) {
        $sid = (int)$sid;
        if (q_val('SELECT 1 FROM songs WHERE id = ?', [$sid])) foreach (same_sheet_song_ids($sid) as $x) $targets[(int)$x] = true;
    }
    foreach ($keepSheet as $x) unset($targets[$x]);
    $targets = array_keys($targets);
    q('UPDATE songs SET use_song_id = NULL WHERE id IN (' . marks_sql($keepSheet) . ')', $keepSheet);
    if ($targets) {
        $m = marks_sql($targets);
        q("UPDATE songs SET use_song_id = ?, title = ?, title_manual = 1, song_key = ?, key_source = ?, tempo = ? WHERE id IN ($m)",
          [$keepId, $keep['title'], $keep['song_key'], $keep['key_source'] ?: 'manual', $keep['tempo'], ...$targets]);
        q("UPDATE songs SET use_song_id = ? WHERE use_song_id IN ($m)", [$keepId, ...$targets]);
    }
    return song_from_row(get_song_row($keepId));
}

function api_restore_sheet(int $id): array
{
    get_song_row($id);
    $ids = array_map('intval', same_sheet_song_ids($id));
    q('UPDATE songs SET use_song_id = NULL WHERE id IN (' . marks_sql($ids) . ')', $ids);
    return song_from_row(get_song_row($id));
}

// ── 그림 / PDF ───────────────────────────────────────────────
function api_page_image(int $id, int $n): void { send_image(page_file($id, $n)); }

function api_thumbnail(int $id): void
{
    $t = thumb_file($id);
    send_image(is_file($t) ? $t : page_file($id, 1));
}

function annotations_of(int $scoreId): array
{
    $out = [];
    foreach (q_all('SELECT page_number, strokes_json FROM annotations WHERE score_id = ?', [$scoreId]) as $a) {
        $out[(int)$a['page_number']] = json_decode((string)$a['strokes_json'], true) ?: [];
    }
    return $out;
}

/** 콘티 전체 PDF: 보기(file)는 필기 없이, 내보내기(export)는 필기를 그려서 */
function api_score_pdf(int $id, bool $withAnnotations): void
{
    $s = score_row($id);
    $annots = $withAnnotations ? annotations_of($id) : [];
    $pdf = new ImagePdf();
    foreach (q_all('SELECT page_number, width, height FROM pages WHERE score_id = ? ORDER BY page_number', [$id]) as $p) {
        $f = page_file($id, (int)$p['page_number']);
        if (is_file($f)) $pdf->addPage($f, (float)$p['width'], (float)$p['height'], $annots[(int)$p['page_number']] ?? []);
    }
    if (!$pdf->pageCount()) throw new ApiError(404, '페이지 그림이 없어요');
    $pdf->output($s['title'] . '.pdf', $withAnnotations);
}

function api_export_setlist(): void
{
    @set_time_limit(120);
    $b = body_json();
    $ids = array_map('intval', (array)($b['song_ids'] ?? []));
    if (!$ids) throw new ApiError(400, '선택한 곡이 없습니다');
    $withAnnot = !array_key_exists('include_annotations', $b) || !empty($b['include_annotations']);
    $pdf = new ImagePdf();
    $annotCache = [];
    foreach ($ids as $sid) {
        $r = q_one('SELECT * FROM songs WHERE id = ?', [$sid]);
        if (!$r) throw new ApiError(404, "곡을 찾을 수 없습니다 (id=$sid)");
        if ($r['use_song_id']) {   // 하나만 남긴 악보로 내보낸다 (제목은 이 곡 그대로)
            $k = q_one('SELECT * FROM songs WHERE id = ?', [$r['use_song_id']]);
            if ($k) { $r['score_id'] = $k['score_id']; $r['page_start'] = $k['page_start']; $r['page_end'] = $k['page_end']; }
        }
        $sc = (int)$r['score_id'];
        if ($withAnnot && !isset($annotCache[$sc])) $annotCache[$sc] = annotations_of($sc);
        $first = null;
        foreach (q_all('SELECT page_number, width, height FROM pages WHERE score_id = ? AND page_number BETWEEN ? AND ? ORDER BY page_number',
                       [$sc, $r['page_start'], $r['page_end']]) as $p) {
            $f = page_file($sc, (int)$p['page_number']);
            if (!is_file($f)) continue;
            $idx = $pdf->addPage($f, (float)$p['width'], (float)$p['height'], $annotCache[$sc][(int)$p['page_number']] ?? []);
            $first ??= $idx;
        }
        if ($first !== null) $pdf->addBookmark($r['title'], $first);
    }
    if (!$pdf->pageCount()) throw new ApiError(404, '악보 그림이 없어요');
    $pdf->output((trim((string)($b['title'] ?? '')) ?: '새 콘티') . '.pdf');
}

// ── 필기 ─────────────────────────────────────────────────────
function api_get_annotations(int $id, int $n): array
{
    score_row($id);
    $r = q_val('SELECT strokes_json FROM annotations WHERE score_id = ? AND page_number = ?', [$id, $n]);
    return ['strokes' => $r ? (json_decode((string)$r, true) ?: []) : []];
}

function api_put_annotations(int $id, int $n): array
{
    score_row($id);
    $strokes = body_json()['strokes'] ?? [];
    if (!is_array($strokes)) $strokes = [];
    q('INSERT INTO annotations (score_id, page_number, strokes_json) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE strokes_json = VALUES(strokes_json), updated_at = NOW()',
      [$id, $n, json_encode($strokes)]);
    return ['success' => true];
}

// ── 즐겨찾기 / 라이브(NOW) ───────────────────────────────────
function api_get_marks(): array
{
    $out = [];
    foreach (q_all('SELECT group_key, mark FROM song_marks ORDER BY created_at') as $r) $out[$r['group_key']][] = $r['mark'];
    return ['palette' => MARKS, 'marks' => (object)$out];
}

function api_set_marks(): array
{
    $b = body_json();
    $key = trim((string)($b['group_key'] ?? ''));
    if ($key === '' || mb_strlen($key) > 200) throw new ApiError(400, '곡 정보가 잘못됐어요');
    $marks = array_values(array_unique(array_filter((array)($b['marks'] ?? []), fn($m) => in_array($m, MARKS, true))));
    q('DELETE FROM song_marks WHERE group_key = ?', [$key]);
    foreach ($marks as $m) q('INSERT INTO song_marks (group_key, mark) VALUES (?, ?)', [$key, $m]);
    return ['group_key' => $key, 'marks' => $marks];
}

function current_live(): ?array
{
    $v = state_get('live');
    $live = $v ? json_decode($v, true) : null;
    if ($live && time() - (int)$live['started_ts'] > LIVE_TTL_SECONDS) return null;
    return $live ?: null;
}

function api_get_live(): array { return ['live' => current_live()]; }

function live_songs_for(array $ids, array $sheetOf): array
{
    $ids = array_slice(array_values(array_unique(array_map('intval', $ids))), 0, 80);
    if (!$ids) return [];
    $rows = [];
    foreach (q_all(SONG_SELECT . ' WHERE so.id IN (' . marks_sql($ids) . ')', $ids) as $r) $rows[(int)$r['id']] = song_from_row($r, $sheetOf);
    $out = [];
    foreach ($ids as $i) {
        if (isset($rows[$i])) $out[] = array_intersect_key($rows[$i], array_flip(['id', 'title', 'key', 'image_urls']));
    }
    return $out;
}

/** NOW / 예배 라이브: sets(여러 콘티)를 보내면 위 메뉴에서 오가며 본다. song_ids 만 보내면 콘티 하나 */
function api_start_live(): array
{
    $b = body_json();
    $raw = !empty($b['sets']) && is_array($b['sets']) ? $b['sets'] : [['title' => $b['title'] ?? '', 'song_ids' => $b['song_ids'] ?? []]];
    $sheetOf = sheet_of_map();
    $sets = [];
    foreach (array_slice($raw, 0, 12) as $st) {
        $songs = live_songs_for((array)($st['song_ids'] ?? []), $sheetOf);
        if ($songs) {
            $sets[] = [
                'title' => mb_substr(trim((string)($st['title'] ?? '')), 0, 100) ?: '콘티',
                'conti_id' => isset($st['conti_id']) ? (int)$st['conti_id'] : null,
                'songs' => $songs,
            ];
        }
    }
    if (!$sets) throw new ApiError(400, '보낼 곡이 없어요');
    $now = microtime(true);
    $live = [
        'id' => (int)($now * 1000),
        'title' => mb_substr(trim((string)($b['title'] ?? '')), 0, 100) ?: $sets[0]['title'],
        'date' => valid_date($b['date'] ?? null),
        'sets' => $sets,
        'songs' => array_merge(...array_column($sets, 'songs')),   // 예전 화면용 (한 줄로)
        'started_ts' => (int)$now,
        'started_at' => date('H:i', (int)$now),
    ];
    state_set('live', json_encode($live, JSON_UNESCAPED_UNICODE));
    return ['live' => $live];
}

function api_stop_live(): array
{
    state_set('live', null);
    return ['live' => null];
}

// ── 예배 라이브 셋팅 (날짜별) ─────────────────────────────────
function valid_date($d): ?string
{
    return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) ? $d : null;
}

function service_out(string $date, array $data): array
{
    return ['date' => $date, 'title' => $data['title'] ?? '', 'sets' => $data['sets'] ?? []];
}

function api_list_services(): array
{
    $out = [];
    foreach (q_all("SELECT k, v FROM app_state WHERE k LIKE 'service:%' ORDER BY k DESC LIMIT 60") as $r) {
        $out[] = service_out(substr($r['k'], 8), json_decode((string)$r['v'], true) ?: []);
    }
    return ['services' => $out];
}

function api_get_service(string $date): array
{
    if (!valid_date($date)) throw new ApiError(400, '날짜 형식이 잘못됐어요');
    $v = state_get("service:$date");
    return ['service' => $v ? service_out($date, json_decode($v, true) ?: []) : null];
}

function api_put_service(string $date): array
{
    if (!valid_date($date)) throw new ApiError(400, '날짜 형식이 잘못됐어요');
    $b = body_json();
    $sets = [];
    foreach (array_slice((array)($b['sets'] ?? []), 0, 12) as $st) {
        $ids = array_slice(array_values(array_unique(array_map('intval', (array)($st['song_ids'] ?? [])))), 0, 80);
        if (!$ids) continue;
        $sets[] = ['title' => mb_substr(trim((string)($st['title'] ?? '')), 0, 100) ?: '콘티',
                   'conti_id' => isset($st['conti_id']) ? (int)$st['conti_id'] : null, 'song_ids' => $ids];
    }
    $data = ['title' => mb_substr(trim((string)($b['title'] ?? '')), 0, 100), 'sets' => $sets];
    state_set("service:$date", json_encode($data, JSON_UNESCAPED_UNICODE));
    return ['service' => service_out($date, $data)];
}

function api_delete_service(string $date): array
{
    if (!valid_date($date)) throw new ApiError(400, '날짜 형식이 잘못됐어요');
    q('DELETE FROM app_state WHERE k = ?', ["service:$date"]);
    return ['success' => true];
}
