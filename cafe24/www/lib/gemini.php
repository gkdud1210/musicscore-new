<?php
/**
 * 제미나이로 악보 페이지 한 장 읽기 (맥 버전 backend/gemini_ocr.py 와 같은 질문·답 모양)
 * 카페24는 요청 하나가 오래 걸리면 끊길 수 있어서, 여기서는 한 번만 묻고
 * 한도 초과(429)·일시 오류는 브라우저가 기다렸다가 다시 부른다.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent';

const GEMINI_PROMPT = <<<'TXT'
You read one page of Korean worship song sheet music (찬양 악보), scanned or exported from a worship team's setlist (콘티) PDF.

Report as JSON:
- is_sheet_music: false for covers, order-of-service pages, announcements, lyric-only slides with no staff/chords, or blank pages.
- starts_new_song: true if a song title is printed at the top of this page (the start of a song). false if this page continues the previous page's song (no title, or only a small running header).
- title: the song title exactly as printed (keep Korean as written; drop numbering, "Key", composer names, copyright text). Empty string if there is no title.
- key: the song's key as a letter name, e.g. "G", "Bb", "F#m". Use an explicit marking if present ("Key: G", "G코드", "원키 A", "(D)"). Otherwise infer it from the key signature and chord symbols. Empty string only if there is no music.
- chords: chord symbols in reading order as printed (e.g. "G", "D/F#", "Em7"). Do not invent chords.
- lyrics: the lyric text in reading order, one sung line per line, Korean as written. No chords, titles or credits.
TXT;

function gemini_available(): bool { return trim((string)cfg('gemini_api_key')) !== ''; }

function gemini_schema(): array
{
    return [
        'type' => 'OBJECT',
        'properties' => [
            'is_sheet_music' => ['type' => 'BOOLEAN'],
            'starts_new_song' => ['type' => 'BOOLEAN'],
            'title' => ['type' => 'STRING'],
            'key' => ['type' => 'STRING'],
            'chords' => ['type' => 'ARRAY', 'items' => ['type' => 'STRING']],
            'lyrics' => ['type' => 'STRING'],
        ],
        'required' => ['is_sheet_music', 'starts_new_song', 'title', 'key', 'chords', 'lyrics'],
        'propertyOrdering' => ['is_sheet_music', 'starts_new_song', 'title', 'key', 'chords', 'lyrics'],
    ];
}

function gemini_post(array $body, string $model, int $timeout = 70): array
{
    $ch = curl_init(sprintf(GEMINI_URL, rawurlencode($model)));
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'x-goog-api-key: ' . trim((string)cfg('gemini_api_key'))],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    $raw = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) return [0, "연결 실패: $err"];
    return [$code, (string)$raw];
}

/** JPEG 파일 하나 → 페이지 분석 결과 (맥 버전 analyze_page 와 같은 모양) */
function gemini_read_page(string $jpegPath, int $pageNumber, int $pageCount): array
{
    if (!gemini_available()) throw new ApiError(400, '제미나이 API 키가 없어요 (config.php 의 gemini_api_key)');
    $gen = ['temperature' => 0, 'responseMimeType' => 'application/json', 'responseSchema' => gemini_schema()];
    $level = trim((string)cfg('gemini_thinking'));
    $flag = DATA_DIR . '/.gemini_no_thinking';
    if ($level !== '' && !is_file($flag)) $gen['thinkingConfig'] = ['thinkingLevel' => $level];
    $body = [
        'contents' => [['role' => 'user', 'parts' => [
            ['inline_data' => ['mime_type' => 'image/jpeg', 'data' => base64_encode((string)file_get_contents($jpegPath))]],
            ['text' => GEMINI_PROMPT . "\n\nThis is page $pageNumber of $pageCount."],
        ]]],
        'generationConfig' => $gen,
    ];
    // 기본 모델이 바쁘면(한도·서버 오류·응답 없음) 가벼운 모델로 한 번 더 (2026-11-08: Flash 가 한동안 429/무응답)
    $primary = trim((string)cfg('gemini_model')) ?: 'gemini-flash-latest';
    $fallback = trim((string)cfg('gemini_fallback_model')) ?: 'gemini-flash-lite-latest';
    $models = $fallback !== $primary ? [$primary, $fallback] : [$primary];
    foreach ($models as $mi => $model) {
        $b = $body;
        if ($mi > 0) unset($b['generationConfig']['thinkingConfig']);
        [$code, $raw] = gemini_post($b, $model, $mi === 0 ? 60 : 70);
        if ($code === 400 && isset($b['generationConfig']['thinkingConfig']) && stripos($raw, 'thinking') !== false) {
            // 이 모델은 생각 수준 설정을 모름 → 기억해 두고 빼고 다시
            @file_put_contents($flag, date('c'));
            unset($b['generationConfig']['thinkingConfig']);
            [$code, $raw] = gemini_post($b, $model);
        }
        if ($code === 200 || !($code === 0 || $code === 429 || $code >= 500)) break;
    }
    if ($code !== 200) {
        $detail = mb_substr($raw, 0, 300);
        if ($code === 401 || $code === 403 || ($code === 400 && str_contains($detail, 'API key'))) {
            throw new ApiError(400, '제미나이 API 키가 올바르지 않거나 권한이 없어요');
        }
        if ($code === 404) throw new ApiError(400, '제미나이 모델을 찾을 수 없어요 (config.php 의 gemini_model)');
        if ($code === 429) throw new ApiError(429, '제미나이 사용량 한도 — 잠시 기다렸다가 다시 할게요');
        if ($code === 0) throw new ApiError(503, '제미나이가 응답하지 않아요 — 잠시 뒤 다시 할게요');
        if ($code >= 500) throw new ApiError(503, "제미나이 서버가 잠시 바빠요 ($code)");
        throw new ApiError(502, "제미나이 오류 ($code): $detail");
    }
    $data = json_decode($raw, true) ?: [];
    $cand = $data['candidates'][0] ?? null;
    if (!$cand) {
        $reason = $data['promptFeedback']['blockReason'] ?? '답 없음';
        throw new ApiError(502, "제미나이가 {$pageNumber}쪽을 읽지 못했어요 ($reason)");
    }
    $text = '';
    foreach ($cand['content']['parts'] ?? [] as $p) {
        if (empty($p['thought'])) $text .= $p['text'] ?? '';
    }
    $r = json_decode($text, true);
    if (!is_array($r)) throw new ApiError(502, "제미나이 답을 읽을 수 없어요 ({$pageNumber}쪽)");

    $chords = [];
    foreach ($r['chords'] ?? [] as $c) {
        $m = match_chord((string)$c);
        if ($m !== null) $chords[] = $m;
    }
    $title = trim((string)($r['title'] ?? ''));
    $isMusic = !empty($r['is_sheet_music']);
    return [
        'page_number' => $pageNumber,
        'title_guess' => $title !== '' ? mb_substr($title, 0, 250) : null,
        // 표지·순서지는 새 곡으로 시작하게 해서 앞 곡에 붙지 않게 한다 (확인 화면에서 빼기)
        'has_title' => ($title !== '' && !empty($r['starts_new_song'])) || !$isMusic,
        'key_explicit' => $isMusic ? normalize_key((string)($r['key'] ?? '')) : '',
        'chords' => $chords,
        'lyrics_text' => trim((string)($r['lyrics'] ?? '')),
    ];
}
