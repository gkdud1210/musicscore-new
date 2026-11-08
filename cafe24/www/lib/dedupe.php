<?php
/**
 * 같은 악보 / 겹치는 콘티 찾기 — 맥 버전 backend/dedupe.py 와 같은 방법.
 * 페이지 그림의 "지문"(32x32 = 1024비트)을 저장해 두고, 다른 비트가 MATCH_BITS 이하면 같은 악보.
 */

const HASH_N = 32;
// 이웃 밝기 차이가 HASH_TOLERANCE 이하면 '같음'(0)으로 본다. 형광펜 칠한 넓은 면처럼 거의 같은 색이 이어지는 곳에서
// 그리는 프로그램(브라우저 PDF.js / 맥 PyMuPDF)에 따라 비트가 마구 뒤집히는 것을 막는다.
// 실제 콘티 199쪽으로 잰 값 (2026-11-08, 허용치 8):
//   맥 버전이 같은 악보로 본 곡들의 첫 쪽: 모두 13 이하 / 같은 곡의 다른 키 악보(Awesome God G·C): 15
//   같은 페이지를 브라우저와 맥이 각각 그린 것: 6, 6, 17
// → 13 이하만 같은 악보. 애매하면 '다른 악보'로 두고 제미나이로 다시 읽는 게 안전하다 (키를 잘못 가져오지 않게).
const HASH_TOLERANCE = 8;
const MATCH_BITS = 13;
const HASH_CHUNKS = 64;          // 1024비트를 16비트(16진수 4글자)씩 64조각 → 13개 이하로 다르면 적어도 51조각은 똑같다

/** JPEG 파일 → 256글자 16진수 지문 */
function page_hash_file(string $path): string
{
    $src = @imagecreatefromjpeg($path);
    if (!$src) throw new ApiError(400, '페이지 그림을 열 수 없어요');
    $w = imagesx($src);
    $h = imagesy($src);
    $tw = 300;
    $th = max(1, (int)round($h * $tw / max($w, 1)));
    $small = imagecreatetruecolor($tw, $th);
    imagecopyresampled($small, $src, 0, 0, 0, 0, $tw, $th, $w, $h);
    unset($src);
    imagefilter($small, IMG_FILTER_GRAYSCALE);
    // 흰 여백 잘라내기
    $minX = $tw; $minY = $th; $maxX = -1; $maxY = -1;
    for ($y = 0; $y < $th; $y++) {
        for ($x = 0; $x < $tw; $x++) {
            if ((imagecolorat($small, $x, $y) & 0xFF) < 215) {
                if ($x < $minX) $minX = $x;
                if ($x > $maxX) $maxX = $x;
                if ($y < $minY) $minY = $y;
                if ($y > $maxY) $maxY = $y;
            }
        }
    }
    if ($maxX < 0) { $minX = 0; $minY = 0; $maxX = $tw - 1; $maxY = $th - 1; }
    $g = imagecreatetruecolor(HASH_N + 1, HASH_N);
    imagecopyresampled($g, $small, 0, 0, $minX, $minY, HASH_N + 1, HASH_N, $maxX - $minX + 1, $maxY - $minY + 1);
    unset($small);
    $bits = '';
    for ($r = 0; $r < HASH_N; $r++) {
        for ($c = 0; $c < HASH_N; $c++) {
            $bits .= ((imagecolorat($g, $c, $r) & 0xFF) > (imagecolorat($g, $c + 1, $r) & 0xFF) + HASH_TOLERANCE) ? '1' : '0';
        }
    }
    unset($g);
    $hex = '';
    foreach (str_split($bits, 4) as $nib) $hex .= dechex(bindec($nib));
    return $hex;
}

function hash_dist(string $a, string $b): int
{
    static $pop = null;
    if ($pop === null) { $pop = []; for ($i = 0; $i < 256; $i++) $pop[$i] = substr_count(decbin($i), '1'); }
    $x = hex2bin($a) ^ hex2bin($b);
    $n = 0;
    foreach (count_chars($x, 1) as $byte => $cnt) $n += $pop[$byte] * $cnt;
    return $n;
}

function hash_same(?string $a, ?string $b): bool
{
    return $a !== null && $b !== null && strlen($a) === 256 && strlen($b) === 256 && hash_dist($a, $b) <= MATCH_BITS;
}

/** 비교 결과 (DB가 바뀔 때만 다시 계산해서 파일에 저장) */
function dedupe_index(): array
{
    static $mem = null;
    $sig = implode(',', q_one("SELECT
        (SELECT COUNT(*) FROM pages WHERE h IS NOT NULL) a,
        (SELECT COALESCE(SUM(score_id * 1000 + page_number), 0) FROM pages WHERE h IS NOT NULL) b,
        (SELECT COUNT(*) FROM songs) c,
        (SELECT COALESCE(SUM(id * 7 + page_start * 31 + page_end), 0) FROM songs) d,
        (SELECT COUNT(*) FROM scores) e"));
    if ($mem && $mem['sig'] === $sig) return $mem;
    $file = DATA_DIR . '/.dedupe_cache.json';
    if (is_file($file)) {
        $c = json_decode((string)file_get_contents($file), true);
        if (($c['sig'] ?? '') === $sig) return $mem = $c;
    }

    $hashes = [];
    foreach (q_all('SELECT score_id, page_number, h FROM pages WHERE h IS NOT NULL') as $r) {
        if (strlen($r['h']) === 256) $hashes[$r['score_id'] . ':' . $r['page_number']] = $r['h'];
    }
    $keys = array_keys($hashes);
    sort($keys);
    $parent = array_combine($keys, $keys) ?: [];
    $find = function ($k) use (&$parent) {
        while ($parent[$k] !== $k) { $parent[$k] = $parent[$parent[$k]]; $k = $parent[$k]; }
        return $k;
    };
    $buckets = [];
    foreach ($keys as $k) {
        for ($c = 0; $c < HASH_CHUNKS; $c++) $buckets[$c . '|' . substr($hashes[$k], $c * 4, 4)][] = $k;
    }
    $seen = [];
    foreach ($buckets as $members) {
        $n = count($members);
        if ($n < 2) continue;
        for ($i = 0; $i < $n; $i++) {
            for ($j = $i + 1; $j < $n; $j++) {
                $pk = $members[$i] . '#' . $members[$j];
                if (isset($seen[$pk])) continue;
                $seen[$pk] = true;
                if (hash_dist($hashes[$members[$i]], $hashes[$members[$j]]) <= MATCH_BITS) {
                    $ra = $find($members[$i]);
                    $rb = $find($members[$j]);
                    if ($ra !== $rb) {
                        // 작은 쪽을 대표로 (콘티 번호, 페이지 번호 순)
                        [$lo, $hi] = page_key_cmp($ra, $rb) < 0 ? [$ra, $rb] : [$rb, $ra];
                        $parent[$hi] = $lo;
                    }
                }
            }
        }
    }
    $cluster = [];
    foreach ($keys as $k) $cluster[$k] = $find($k);

    // 곡 → 악보 묶음: 첫 페이지가 같은 악보면 같은 묶음 (묶음 번호 = 가장 작은 곡 id)
    $sheetRoot = [];
    $sheetOf = [];
    foreach (q_all('SELECT id, score_id, page_start FROM songs ORDER BY id') as $s) {
        $c = $cluster[$s['score_id'] . ':' . $s['page_start']] ?? null;
        if ($c === null) { $sheetOf[$s['id']] = (int)$s['id']; continue; }
        $sheetRoot[$c] ??= (int)$s['id'];
        $sheetOf[$s['id']] = $sheetRoot[$c];
    }
    $members = [];
    foreach ($sheetOf as $sid => $root) $members[$root][] = (int)$sid;

    // 콘티끼리 겹침
    // '새 콘티'로 만들어 저장한 콘티는 원래 곡들과 겹치는 게 당연하므로 겹침 검사에서 뺀다
    $fromSetlist = array_flip(array_map('intval', array_column(q_all('SELECT id FROM scores WHERE from_setlist = 1'), 'id')));
    $pagesOf = [];
    foreach ($cluster as $k => $c) {
        $sid = (int)explode(':', $k)[0];
        if (!isset($fromSetlist[$sid])) $pagesOf[$sid][$c] = true;
    }
    $holders = [];
    foreach ($pagesOf as $sid => $cs) foreach ($cs as $c => $_) $holders[$c][] = $sid;
    $shared = [];
    foreach ($holders as $sids) {
        foreach ($sids as $a) foreach ($sids as $b) if ($a !== $b) $shared["$a:$b"] = ($shared["$a:$b"] ?? 0) + 1;
    }
    $overlaps = [];
    foreach ($shared as $ab => $n) {
        [$a, $b] = array_map('intval', explode(':', $ab));
        $na = count($pagesOf[$a]);
        $nb = count($pagesOf[$b]);
        $same = $na === $nb && !array_diff_key($pagesOf[$a], $pagesOf[$b]);
        if ($same) $kind = 'same';
        elseif ($n === $na) $kind = 'inside';
        elseif ($n === $nb) $kind = 'contains';
        elseif ($n * 2 >= $na) $kind = 'partial';
        else continue;
        $overlaps[$a][] = ['id' => $b, 'shared' => $n, 'kind' => $kind];
    }
    $order = ['same' => 0, 'inside' => 1, 'contains' => 2, 'partial' => 3];
    foreach ($overlaps as &$v) {
        usort($v, fn($x, $y) => [$order[$x['kind']], -$x['shared']] <=> [$order[$y['kind']], -$y['shared']]);
    }
    unset($v);

    $mem = ['sig' => $sig, 'sheet_of' => $sheetOf, 'members' => $members, 'overlaps' => $overlaps];
    @file_put_contents($file, json_encode($mem));
    return $mem;
}

function page_key_cmp(string $a, string $b): int
{
    [$sa, $pa] = array_map('intval', explode(':', $a));
    [$sb, $pb] = array_map('intval', explode(':', $b));
    return [$sa, $pa] <=> [$sb, $pb];
}

function sheet_of_map(): array { return dedupe_index()['sheet_of']; }

function same_sheet_song_ids(int $songId): array
{
    $idx = dedupe_index();
    $root = $idx['sheet_of'][$songId] ?? $songId;
    return $idx['members'][$root] ?? [$songId];
}

function overlaps_for(int $scoreId): array { return dedupe_index()['overlaps'][$scoreId] ?? []; }

/** 새 콘티의 페이지 하나와 같은 그림인, 이미 읽은 다른 콘티의 페이지 (확인된 콘티 먼저) */
function reference_page(int $scoreId, string $h): ?array
{
    $best = null;
    $rows = q_all("SELECT p.*, sc.confirmed FROM pages p JOIN scores sc ON sc.id = p.score_id
                   WHERE p.score_id != ? AND p.analyzed = 1 AND p.h IS NOT NULL
                   ORDER BY sc.confirmed DESC, p.score_id DESC", [$scoreId]);
    foreach ($rows as $r) {
        if (strlen($r['h']) !== 256) continue;
        $d = hash_dist($h, $r['h']);
        if ($d <= MATCH_BITS && ($best === null || $d < $best[0])) {
            $best = [$d, $r];
            if ($d === 0) break;
        }
    }
    return $best[1] ?? null;
}

/** 새 콘티에서 확인된 콘티의 곡과 페이지가 순서대로 똑같은 구간 → [[시작, 끝, 원래 곡 row], ...] */
function reference_songs(int $scoreId, array $hashes): array
{
    $cands = q_all("SELECT so.* FROM songs so JOIN scores sc ON sc.id = so.score_id
                    WHERE so.score_id != ? AND sc.confirmed = 1 AND sc.status != 'processing'", [$scoreId]);
    if (!$cands) return [];
    $ph = [];
    foreach (q_all("SELECT score_id, page_number, h FROM pages WHERE h IS NOT NULL
                    AND score_id IN (SELECT id FROM scores WHERE confirmed = 1)") as $r) {
        $ph[$r['score_id'] . ':' . $r['page_number']] = $r['h'];
    }
    usort($cands, fn($a, $b) => [-$a['title_manual'], -($a['page_end'] - $a['page_start']), -$a['id']]
        <=> [-$b['title_manual'], -($b['page_end'] - $b['page_start']), -$b['id']]);
    $out = [];
    $n = count($hashes);
    $i = 1;
    while ($i <= $n) {
        $hit = null;
        foreach ($cands as $s) {
            $len = $s['page_end'] - $s['page_start'] + 1;
            if ($i + $len - 1 > $n) continue;
            $ok = true;
            for ($k = 0; $k < $len; $k++) {
                if (!hash_same($hashes[$i + $k] ?? null, $ph[$s['score_id'] . ':' . ($s['page_start'] + $k)] ?? null)) { $ok = false; break; }
            }
            if ($ok) { $hit = [$i, $i + $len - 1, $s]; break; }
        }
        if ($hit) { $out[] = $hit; $i = $hit[1] + 1; } else { $i++; }
    }
    return $out;
}

/** OCR로 나눈 곡 구간에 '기존 악보와 같은 구간'을 덮어쓴다 → [[시작, 끝, 원래 곡 row 또는 null], ...] */
function merge_segments(array $segments, array $forced): array
{
    $covered = [];
    foreach ($forced as [$a, $b]) for ($p = $a; $p <= $b; $p++) $covered[$p] = true;
    $out = $forced;
    foreach ($segments as [$a, $b]) {
        $run = null;
        for ($p = $a; $p <= $b; $p++) {
            if (isset($covered[$p])) {
                if ($run) { $out[] = [$run[0], $run[1], null]; $run = null; }
            } else {
                $run = $run ? [$run[0], $p] : [$p, $p];
            }
        }
        if ($run) $out[] = [$run[0], $run[1], null];
    }
    usort($out, fn($x, $y) => $x[0] <=> $y[0]);
    return $out;
}
