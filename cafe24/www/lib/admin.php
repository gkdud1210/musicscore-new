<?php
/**
 * 맥 → 카페24 옮기기 (관리자 전용, 처음 한 번)
 *  1) data/import.json + data/scores/... 를 FTP로 올리고
 *  2) POST /api/admin/import  → DB에 넣기 (콘티가 하나도 없을 때만)
 *  3) POST /api/admin/rehash  → 페이지 지문 만들기 (한 번에 몇십 장씩, 남은 게 0이 될 때까지)
 */

function api_admin_import(): array
{
    @set_time_limit(300);
    $file = DATA_DIR . '/import.json';
    if (!is_file($file)) throw new ApiError(404, 'data/import.json 이 없어요. 먼저 FTP로 올려주세요');
    if ((int)q_val('SELECT COUNT(*) FROM scores') > 0) {
        throw new ApiError(409, '이미 콘티가 있어서 옮기기를 하지 않았어요 (두 번 넣는 것 방지)');
    }
    $b = json_decode((string)file_get_contents($file), true);
    if (!is_array($b) || !isset($b['scores'])) throw new ApiError(400, 'import.json 형식이 이상해요');

    $pdo = db();
    $pdo->beginTransaction();
    try {
        foreach ($b['scores'] as $s) {
            q('INSERT INTO scores (id, title, original_filename, page_count, conti_date, file_hash, confirmed, status, status_detail,
                                   chords_text, lyrics_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
              [$s['id'], $s['title'], $s['original_filename'], $s['page_count'], $s['conti_date'] ?: null, $s['file_hash'] ?: null,
               (int)$s['confirmed'], $s['status'], $s['status_detail'], $s['chords_text'], $s['lyrics_text'],
               $s['created_at'], $s['updated_at']]);
        }
        foreach ($b['pages'] as $p) {
            q('INSERT INTO pages (score_id, page_number, width, height, analyzed, title_guess, has_title, key_explicit, chords_json, lyrics_text)
               VALUES (?,?,?,?,?,?,?,?,?,?)',
              [$p['score_id'], $p['page_number'], $p['width'], $p['height'], (int)$p['analyzed'], $p['title_guess'],
               (int)$p['has_title'], (string)$p['key_explicit'], $p['chords_json'] ?: '[]', (string)$p['lyrics_text']]);
        }
        // 곡: 먼저 넣고, '하나만 남긴 악보' 연결은 다 넣은 뒤에 (서로 가리키므로)
        foreach ($b['songs'] as $s) {
            q('INSERT INTO songs (id, score_id, page_start, page_end, title, song_key, key_source, title_manual, lyrics_text, chords_text,
                                  section, tempo, matched_from, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              [$s['id'], $s['score_id'], $s['page_start'], $s['page_end'], $s['title'], $s['song_key'], $s['key_source'],
               (int)$s['title_manual'], $s['lyrics_text'], $s['chords_text'], $s['section'] ?? '', $s['tempo'] ?? '',
               $s['matched_from'], $s['created_at']]);
        }
        foreach ($b['songs'] as $s) {
            if (!empty($s['use_song_id'])) q('UPDATE songs SET use_song_id = ? WHERE id = ?', [$s['use_song_id'], $s['id']]);
        }
        foreach ($b['annotations'] as $a) {
            q('INSERT INTO annotations (score_id, page_number, strokes_json, updated_at) VALUES (?,?,?,?)',
              [$a['score_id'], $a['page_number'], $a['strokes_json'], $a['updated_at']]);
        }
        foreach ($b['marks'] as $m) {
            q('INSERT IGNORE INTO song_marks (group_key, mark, created_at) VALUES (?,?,?)', [$m['group_key'], $m['mark'], $m['created_at']]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    @rename($file, DATA_DIR . '/import.done.json');
    return [
        'scores' => count($b['scores']), 'pages' => count($b['pages']), 'songs' => count($b['songs']),
        'annotations' => count($b['annotations']), 'marks' => count($b['marks']),
        'hash_remaining' => (int)q_val('SELECT COUNT(*) FROM pages WHERE h IS NULL'),
    ];
}

function api_admin_rehash(): array
{
    @set_time_limit(120);
    $started = microtime(true);
    $done = 0;
    $missing = 0;
    foreach (q_all('SELECT score_id, page_number FROM pages WHERE h IS NULL ORDER BY score_id, page_number LIMIT 80') as $p) {
        $f = page_file((int)$p['score_id'], (int)$p['page_number']);
        if (!is_file($f)) {
            q("UPDATE pages SET h = '' WHERE score_id = ? AND page_number = ?", [$p['score_id'], $p['page_number']]);
            $missing++;
            continue;
        }
        q('UPDATE pages SET h = ? WHERE score_id = ? AND page_number = ?', [page_hash_file($f), $p['score_id'], $p['page_number']]);
        $done++;
        if (microtime(true) - $started > 20) break;   // 요청 하나가 너무 길지 않게
    }
    return ['done' => $done, 'missing_images' => $missing, 'remaining' => (int)q_val('SELECT COUNT(*) FROM pages WHERE h IS NULL')];
}
