<?php
/**
 * 코드·키 다루기, 곡 나누기, 날짜 추정 — 맥 버전 backend/ocr.py · library.py 와 같은 규칙
 */

const CHORD_RE = '/^[A-G](#|b|♯|♭)?(maj7|maj9|maj|M7|min7|min9|min|m7b5|m7|m9|m6|m|dim7|dim|aug|°|ø|sus2|sus4|sus|add9|add2|6|69|7|9|11|13)?(\(?(b|#)?(5|9|11|13)\)?)?(\/[A-G](#|b|♯|♭)?)?$/u';
const TOKEN_STRIP = "()[]{}|:.,'\"‘’“”-–—~";
const NOTE_PC = ['C' => 0, 'D' => 2, 'E' => 4, 'F' => 5, 'G' => 7, 'A' => 9, 'B' => 11];
const PC_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function mb_trim_chars(string $s, string $chars): string
{
    $set = mb_str_split($chars);
    $a = mb_str_split($s);
    while ($a && in_array($a[0], $set, true)) array_shift($a);
    while ($a && in_array($a[count($a) - 1], $set, true)) array_pop($a);
    return implode('', $a);
}

function match_chord(string $token): ?string
{
    $token = mb_trim_chars(trim($token), TOKEN_STRIP);
    if ($token === '' || mb_strlen($token) > 10) return null;
    if (!preg_match(CHORD_RE, $token)) return null;
    $token = str_replace(['♯', '♭'], ['#', 'b'], $token);
    return strtoupper($token[0]) . substr($token, 1);
}

function normalize_key(?string $k): string
{
    $k = str_replace(['♯', '♭'], ['#', 'b'], trim((string)$k));
    if ($k === '') return '';
    if (!preg_match('/^([A-Ga-g])(#|b)?(m|min|minor)?$/', $k, $m)) return $k;
    return strtoupper($m[1]) . ($m[2] ?? '') . (!empty($m[3]) ? 'm' : '');
}

function chord_root_quality(string $chord): array
{
    if (!preg_match('/^([A-G])(#|b)?(.*)$/u', explode('/', $chord)[0], $m)) return [null, null];
    $pc = NOTE_PC[$m[1]];
    if (($m[2] ?? '') === '#') $pc = ($pc + 1) % 12;
    elseif (($m[2] ?? '') === 'b') $pc = ($pc + 11) % 12;
    $s = $m[3] ?? '';
    if (str_starts_with($s, 'maj') || str_starts_with($s, 'M')) $q = 'maj';
    elseif (str_starts_with($s, 'm7b5') || str_starts_with($s, 'dim') || str_starts_with($s, '°') || str_starts_with($s, 'ø')) $q = 'dim';
    elseif (str_starts_with($s, 'm')) $q = 'min';
    elseif (str_starts_with($s, 'sus')) $q = 'sus';
    else $q = 'maj';
    return [$pc, $q];
}

function spelling_for_pc(int $pc, array $chords): string
{
    foreach ($chords as $c) {
        if (preg_match('/^[A-G](#|b)?/', $c, $m)) {
            [$rpc] = chord_root_quality($m[0]);
            if ($rpc === $pc) return $m[0];
        }
    }
    return PC_NAMES[$pc];
}

function infer_key_from_chords(array $chords): string
{
    $parsed = [];
    foreach ($chords as $c) {
        [$pc, $q] = chord_root_quality($c);
        if ($pc !== null) $parsed[] = [$c, $pc, $q];
    }
    if (!$parsed) return '';
    if (count($parsed) < 3) {
        [, $pc, $q] = $parsed[0];
        return spelling_for_pc($pc, $chords) . ($q === 'min' ? 'm' : '');
    }
    $degrees = [[0, 'maj'], [2, 'min'], [4, 'min'], [5, 'maj'], [7, 'maj'], [9, 'min'], [11, 'dim']];
    $bestPc = 0;
    $best = -INF;
    for ($k = 0; $k < 12; $k++) {
        $expected = [];
        foreach ($degrees as [$iv, $q]) $expected[($k + $iv) % 12] = $q;
        $score = 0.0;
        foreach ($parsed as [, $pc, $q]) {
            if (isset($expected[$pc])) $score += ($q === $expected[$pc] || $q === 'sus') ? 1.0 : 0.3;
            else $score -= 0.5;
        }
        foreach ($parsed as [$c, $pc, $q]) {
            if ($q === 'maj' && preg_match('/^[A-G](#|b)?7/', $c) && $pc === ($k + 7) % 12) $score += 1.0;
        }
        [, $fpc, $fq] = $parsed[0];
        [, $lpc, $lq] = $parsed[count($parsed) - 1];
        if ($fpc === $k && in_array($fq, ['maj', 'sus'], true)) $score += 2.0;
        if ($lpc === $k && in_array($lq, ['maj', 'sus'], true)) $score += 1.0;
        if ($score > $best) { $best = $score; $bestPc = $k; }
    }
    return spelling_for_pc($bestPc, $chords);
}

function norm_title(?string $t): string
{
    return preg_replace('/[^0-9a-z가-힣]/u', '', mb_strtolower((string)$t));
}

/** 파이썬 difflib.SequenceMatcher(None, a, b).ratio() 와 같은 계산 (글자 단위) */
function seq_ratio(string $a, string $b): float
{
    $A = mb_str_split($a);
    $B = mb_str_split($b);
    $total = count($A) + count($B);
    if (!$total) return 1.0;
    $matches = 0;
    $stack = [[0, count($A), 0, count($B)]];
    while ($stack) {
        [$alo, $ahi, $blo, $bhi] = array_pop($stack);
        $bi = $alo; $bj = $blo; $bsize = 0;
        $prev = [];
        for ($i = $alo; $i < $ahi; $i++) {
            $cur = [];
            for ($j = $blo; $j < $bhi; $j++) {
                if ($A[$i] === $B[$j]) {
                    $len = ($prev[$j - 1] ?? 0) + 1;
                    $cur[$j] = $len;
                    if ($len > $bsize) { $bi = $i - $len + 1; $bj = $j - $len + 1; $bsize = $len; }
                }
            }
            $prev = $cur;
        }
        if ($bsize) {
            $matches += $bsize;
            if ($alo < $bi && $blo < $bj) $stack[] = [$alo, $bi, $blo, $bj];
            if ($bi + $bsize < $ahi && $bj + $bsize < $bhi) $stack[] = [$bi + $bsize, $ahi, $bj + $bsize, $bhi];
        }
    }
    return 2.0 * $matches / $total;
}

function titles_similar(?string $a, ?string $b): bool
{
    $na = norm_title($a);
    $nb = norm_title($b);
    if ($na === '' || $nb === '') return false;
    if ($na === $nb || str_contains($na, $nb) || str_contains($nb, $na)) return true;
    return seq_ratio($na, $nb) >= 0.75;
}

/** 페이지 분석 결과 → [[시작, 끝], ...] (1부터) */
function segment_songs(array $pages): array
{
    $ranges = [];
    $current = null;
    foreach ($pages as $p) {
        $n = (int)$p['page_number'];
        $startsNew = !$ranges || ($p['has_title'] && !titles_similar($p['title_guess'], $current));
        if ($startsNew) {
            $ranges[] = [$n, $n];
            $current = $p['has_title'] ? $p['title_guess'] : null;
        } else {
            $ranges[count($ranges) - 1][1] = $n;
        }
    }
    return $ranges;
}

function build_song_meta(array $pages): array
{
    $first = $pages[0];
    $title = $first['title_guess'] ?: '제목 없음';
    $all = [];
    foreach ($pages as $p) foreach ($p['chords'] as $c) $all[] = $c;
    $key = '';
    $src = '';
    foreach ($pages as $p) {
        if (!empty($p['key_explicit'])) { $key = $p['key_explicit']; $src = 'explicit'; break; }
    }
    if ($key === '') {
        $key = infer_key_from_chords($all);
        $src = $key !== '' ? 'inferred' : '';
    }
    $lyrics = [];
    foreach ($pages as $p) if (!empty($p['lyrics_text'])) $lyrics[] = $p['lyrics_text'];
    return [
        'title' => $title,
        'song_key' => $key,
        'key_source' => $src,
        'lyrics_text' => implode("\n", $lyrics),
        'chords' => array_values(array_unique($all)),
    ];
}

function guess_date(?string $name): ?string
{
    $name = (string)$name;
    $pats = [
        '/(20\d{2})[.\-_\/년\s]+(\d{1,2})[.\-_\/월\s]+(\d{1,2})/u',
        '/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/',
        '/(?<!\d)(\d{2})[.\-_\/](\d{1,2})[.\-_\/](\d{1,2})(?!\d)/',
        '/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/',
    ];
    foreach ($pats as $pat) {
        if (!preg_match($pat, $name, $m)) continue;
        $y = (int)$m[1] + (strlen($m[1]) === 2 ? 2000 : 0);
        $mo = (int)$m[2];
        $d = (int)$m[3];
        if ($mo >= 1 && $mo <= 12 && $d >= 1 && $d <= 31 && $y >= 2000 && $y <= 2100) {
            return sprintf('%04d-%02d-%02d', $y, $mo, $d);
        }
    }
    if (preg_match('/(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/u', $name, $m)) {
        $mo = (int)$m[1];
        $d = (int)$m[2];
        if ($mo >= 1 && $mo <= 12 && $d >= 1 && $d <= 31) {
            $y = (int)date('Y');
            if ([$mo, $d] > [(int)date('n'), (int)date('j')]) $y--;
            return checkdate($mo, $d, $y) ? sprintf('%04d-%02d-%02d', $y, $mo, $d) : null;
        }
    }
    return null;
}
