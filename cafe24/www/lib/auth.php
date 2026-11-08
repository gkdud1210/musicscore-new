<?php
/**
 * 로그인: 관리자 비밀번호 → admin, 팀원 비밀번호 → member.
 * 서명한 쿠키(역할.만료.서명)로 기억한다 — 맥 버전(auth.py)과 같은 방식.
 */

const COOKIE_NAME = 'scoreshift_session';
const LOCKOUT_STEPS = [[20, 86400], [15, 3600], [10, 600], [5, 60]];
const FAILURE_RESET_SECONDS = 86400;

function auth_enabled(): bool { return cfg('app_password') !== '' || cfg('admin_password') !== ''; }

function auth_secret(): string
{
    $base = cfg('secret_key') ?: (cfg('app_password') . '|' . cfg('admin_password'));
    return hash('sha256', 'scoreshift:' . $base, true);
}

function sign_payload(string $payload): string { return hash_hmac('sha256', $payload, auth_secret()); }

function make_token(string $role): string
{
    $payload = $role . '.' . (time() + SESSION_DAYS * 86400);
    return $payload . '.' . sign_payload($payload);
}

function current_role(): ?string
{
    if (!auth_enabled()) return 'admin';
    $parts = explode('.', $_COOKIE[COOKIE_NAME] ?? '');
    if (count($parts) !== 3) return null;
    [$role, $exp, $sig] = $parts;
    if (!in_array($role, ['admin', 'member'], true) || !ctype_digit($exp)) return null;
    if (!hash_equals(sign_payload("$role.$exp"), $sig)) return null;
    if ((int)$exp < time()) return null;
    if ($role === 'admin' && cfg('admin_password') === '') $role = 'member';
    return $role;
}

function can_edit(?string $role): bool
{
    return $role === 'admin' || ($role === 'member' && cfg('admin_password') === '');
}

function client_ip(): string
{
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $h) {
        if (!empty($_SERVER[$h])) return trim(explode(',', $_SERVER[$h])[0]);
    }
    return '?';
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
        || str_contains($_SERVER['HTTP_CF_VISITOR'] ?? '', '"https"');
}

function human_wait(float $s): string
{
    $s = max(1, (int)ceil($s));
    if ($s >= 3600) return ceil($s / 3600) . '시간';
    if ($s >= 60) return ceil($s / 60) . '분';
    return $s . '초';
}

function set_session_cookie(string $value, int $maxAge): void
{
    setcookie(COOKIE_NAME, $value, [
        'expires' => $maxAge > 0 ? time() + $maxAge : time() - 3600,
        'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => is_https(),
    ]);
}

function api_login(): array
{
    if (!auth_enabled()) return ['role' => 'admin', 'auth' => false];
    $ip = client_ip();
    $now = time();
    $f = q_one('SELECT cnt, last_ts FROM login_failures WHERE ip = ?', [$ip]) ?? ['cnt' => 0, 'last_ts' => 0];
    $count = (int)$f['cnt'];
    if ($count && $now - (int)$f['last_ts'] > FAILURE_RESET_SECONDS) $count = 0;
    $lock = 0;
    foreach (LOCKOUT_STEPS as [$th, $sec]) { if ($count >= $th) { $lock = $sec; break; } }
    $wait = $lock - ($now - (int)$f['last_ts']);
    if ($wait > 0) throw new ApiError(429, '비밀번호를 여러 번 틀렸어요. ' . human_wait($wait) . ' 뒤에 다시 시도해주세요.');
    // 여러 IP로 바꿔가며 시도하는 것 막기: 10분에 50번 넘게 틀리면 5분 잠금
    $recent = (int)q_val('SELECT COALESCE(SUM(cnt), 0) FROM login_failures WHERE last_ts > ?', [$now - 600]);
    if ($recent >= 50) throw new ApiError(429, '로그인 시도가 너무 많아요. 잠시 뒤에 다시 시도해주세요.');

    $pw = trim((string)(body_json()['password'] ?? ''));
    $role = null;
    if (cfg('admin_password') !== '' && hash_equals(cfg('admin_password'), $pw)) $role = 'admin';
    elseif (cfg('app_password') !== '' && hash_equals(cfg('app_password'), $pw)) $role = 'member';
    if ($role === null) {
        q('INSERT INTO login_failures (ip, cnt, last_ts) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE cnt = VALUES(cnt), last_ts = VALUES(last_ts)',
          [$ip, $count + 1, $now]);
        throw new ApiError(401, '비밀번호가 맞지 않아요');
    }
    q('DELETE FROM login_failures WHERE ip = ?', [$ip]);
    set_session_cookie(make_token($role), SESSION_DAYS * 86400);
    return ['role' => $role, 'auth' => true];
}

function api_logout(): array
{
    set_session_cookie('', 0);
    return ['success' => true];
}

function api_me(): array
{
    $role = current_role();
    return [
        'auth' => auth_enabled(),
        'role' => $role,
        'can_edit' => can_edit($role),
        'has_admin' => cfg('admin_password') !== '',
        'server' => 'php',   // 화면이 "PDF를 브라우저에서 그림으로 바꿔 올리기" 방식으로 동작하게
    ];
}
