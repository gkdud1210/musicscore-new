<?php
/**
 * 공용: 설정, DB 연결, 표(테이블) 만들기, JSON 응답/오류
 */

declare(strict_types=1);
ini_set('display_errors', '0');   // 경고가 JSON 답에 섞이지 않게 (기록만)
ini_set('log_errors', '1');
mb_internal_encoding('UTF-8');
date_default_timezone_set('Asia/Seoul');

const DATA_DIR = __DIR__ . '/../data';
const SESSION_DAYS = 180;
const MARKS = ['⭐', '❤️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪'];

final class ApiError extends Exception
{
    public int $status;
    public function __construct(int $status, string $detail)
    {
        parent::__construct($detail);
        $this->status = $status;
    }
}

function cfg(?string $key = null)
{
    static $c = null;
    if ($c === null) {
        $file = __DIR__ . '/../config.php';
        if (!is_file($file)) {
            throw new ApiError(500, 'config.php 가 없어요. config.sample.php 를 복사해서 만들어주세요');
        }
        $c = require $file;
    }
    return $key === null ? $c : ($c[$key] ?? '');
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . cfg('db_host') . ';dbname=' . cfg('db_name') . ';charset=utf8mb4';
        if (cfg('db_port')) $dsn .= ';port=' . cfg('db_port');
        if (cfg('db_socket')) $dsn = 'mysql:unix_socket=' . cfg('db_socket') . ';dbname=' . cfg('db_name') . ';charset=utf8mb4';
        $pdo = new PDO($dsn, cfg('db_user'), cfg('db_pass'), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        $pdo->exec("SET time_zone = '+09:00'");
        ensure_schema($pdo);
    }
    return $pdo;
}

/** 준비된 문장 실행 */
function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute(array_values($params));
    return $st;
}

function q_all(string $sql, array $params = []): array { return q($sql, $params)->fetchAll(); }
function q_one(string $sql, array $params = []): ?array { $r = q($sql, $params)->fetch(); return $r === false ? null : $r; }
function q_val(string $sql, array $params = []) { $r = q($sql, $params)->fetchColumn(); return $r === false ? null : $r; }

function marks_sql(array $ids): string { return implode(',', array_fill(0, count($ids), '?')); }

const SCHEMA_VERSION = 5;

function ensure_schema(PDO $pdo): void
{
    $flag = DATA_DIR . '/.schema_v' . SCHEMA_VERSION;
    if (is_file($flag)) return;
    $pdo->exec("CREATE TABLE IF NOT EXISTS scores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        original_filename VARCHAR(255) NULL,
        page_count INT NOT NULL DEFAULT 0,
        conti_date VARCHAR(10) NULL,
        file_hash CHAR(64) NULL,
        confirmed TINYINT NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'ready',
        status_detail VARCHAR(300) NOT NULL DEFAULT '',
        chords_text TEXT NULL,
        lyrics_text MEDIUMTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_scores_hash (file_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS pages (
        score_id INT NOT NULL,
        page_number INT NOT NULL,
        width DOUBLE NOT NULL DEFAULT 595,
        height DOUBLE NOT NULL DEFAULT 842,
        h VARCHAR(256) NULL,
        analyzed TINYINT NOT NULL DEFAULT 0,
        title_guess VARCHAR(255) NULL,
        has_title TINYINT NOT NULL DEFAULT 0,
        key_explicit VARCHAR(16) NOT NULL DEFAULT '',
        chords_json TEXT NULL,
        lyrics_text TEXT NULL,
        PRIMARY KEY (score_id, page_number),
        CONSTRAINT fk_pages_score FOREIGN KEY (score_id) REFERENCES scores(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS songs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        score_id INT NOT NULL,
        page_start INT NOT NULL,
        page_end INT NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '제목 없음',
        song_key VARCHAR(16) NOT NULL DEFAULT '',
        key_source VARCHAR(16) NOT NULL DEFAULT '',
        title_manual TINYINT NOT NULL DEFAULT 0,
        lyrics_text TEXT NULL,
        chords_text TEXT NULL,
        section VARCHAR(8) NOT NULL DEFAULT '',
        tempo VARCHAR(8) NOT NULL DEFAULT '',
        matched_from INT NULL,
        use_song_id INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_songs_score (score_id, page_start),
        KEY idx_songs_key (song_key),
        CONSTRAINT fk_songs_score FOREIGN KEY (score_id) REFERENCES scores(id) ON DELETE CASCADE,
        CONSTRAINT fk_songs_use FOREIGN KEY (use_song_id) REFERENCES songs(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS annotations (
        score_id INT NOT NULL,
        page_number INT NOT NULL,
        strokes_json MEDIUMTEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (score_id, page_number),
        CONSTRAINT fk_annot_score FOREIGN KEY (score_id) REFERENCES scores(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS song_marks (
        group_key VARCHAR(200) NOT NULL,
        mark VARCHAR(16) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_key, mark)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS app_state (
        k VARCHAR(64) PRIMARY KEY,
        v MEDIUMTEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS login_failures (
        ip VARCHAR(64) PRIMARY KEY,
        cnt INT NOT NULL DEFAULT 0,
        last_ts INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    // 접속자 세기: 기기 하나 = 하루 한 줄 (vid 는 브라우저가 만든 무작위 값)
    $pdo->exec("CREATE TABLE IF NOT EXISTS visits (
        vid VARCHAR(40) NOT NULL,
        day DATE NOT NULL,
        role VARCHAR(8) NOT NULL DEFAULT '',
        first_ts INT NOT NULL,
        last_ts INT NOT NULL,
        PRIMARY KEY (vid, day),
        KEY idx_visits_last (last_ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    // v3: '새 콘티'를 라이브러리에 저장한 콘티 표시 (겹치는 콘티 검사에서 뺀다)
    try {
        $pdo->exec("ALTER TABLE scores ADD COLUMN IF NOT EXISTS from_setlist TINYINT NOT NULL DEFAULT 0");
    } catch (Throwable $e) {
        if (!str_contains($e->getMessage(), 'Duplicate column')) throw $e;
    }
    // v4: 접속자 목록에 이름 보이기
    try {
        $pdo->exec("ALTER TABLE visits ADD COLUMN IF NOT EXISTS name VARCHAR(40) NOT NULL DEFAULT ''");
    } catch (Throwable $e) {
        if (!str_contains($e->getMessage(), 'Duplicate column')) throw $e;
    }
    // v5: 배합 콘티 표시 (제목 앞 '배합 · ' 대신)
    try {
        $pdo->exec("ALTER TABLE scores ADD COLUMN IF NOT EXISTS combo TINYINT NOT NULL DEFAULT 0");
    } catch (Throwable $e) {
        if (!str_contains($e->getMessage(), 'Duplicate column')) throw $e;
    }
    $pdo->exec("UPDATE scores SET combo = 1, title = SUBSTRING(title, 6) WHERE from_setlist = 1 AND title LIKE '배합 · %'");
    @mkdir(DATA_DIR . '/scores', 0755, true);
    @file_put_contents($flag, date('c'));
}

function state_get(string $k): ?string { return q_val('SELECT v FROM app_state WHERE k = ?', [$k]); }
function state_set(string $k, ?string $v): void
{
    q('INSERT INTO app_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = NOW()', [$k, $v]);
}

// ── 요청/응답 ────────────────────────────────────────────────
function body_json(): array
{
    static $b = null;
    if ($b === null) {
        $raw = file_get_contents('php://input');
        $b = $raw ? json_decode($raw, true) : [];
        if (!is_array($b)) $b = [];
    }
    return $b;
}

function send_json($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

function content_disposition(string $filename): string
{
    $safe = preg_replace('/[\/\\\\:*?"<>|\r\n]/u', '', $filename) ?: 'score.pdf';
    $ascii = preg_replace('/[^A-Za-z0-9._-]/', '_', $safe) ?: 'score.pdf';
    return "attachment; filename=\"$ascii\"; filename*=UTF-8''" . rawurlencode($safe);
}

function score_dir(int $id): string
{
    $d = DATA_DIR . "/scores/$id";
    if (!is_dir($d)) @mkdir($d, 0755, true);
    return $d;
}

function page_file(int $scoreId, int $n): string { return DATA_DIR . "/scores/$scoreId/p$n.jpg"; }
function thumb_file(int $scoreId): string { return DATA_DIR . "/scores/$scoreId/thumb.jpg"; }

function rrmdir(string $dir): void
{
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = "$dir/$f";
        is_dir($p) ? rrmdir($p) : @unlink($p);
    }
    @rmdir($dir);
}

/** 그림 파일을 로그인한 사람에게만, 브라우저 캐시와 함께 보낸다 */
function send_image(string $path, string $type = 'image/jpeg'): void
{
    if (!is_file($path)) throw new ApiError(404, '그림을 찾을 수 없어요');
    $mtime = filemtime($path);
    $etag = '"' . dechex($mtime) . '-' . dechex(filesize($path)) . '"';
    header('Cache-Control: private, max-age=86400');
    header("ETag: $etag");
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        return;
    }
    header("Content-Type: $type");
    header('Content-Length: ' . filesize($path));
    readfile($path);
}
