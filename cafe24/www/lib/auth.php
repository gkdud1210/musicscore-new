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

function make_token(string $role, string $pid = ''): string
{
    $payload = $role . '.' . (time() + SESSION_DAYS * 86400) . ($pid !== '' ? '.' . $pid : '');
    return $payload . '.' . sign_payload($payload);
}

/* ── 사람마다 입장코드 (예: 1111 → 사모님) — app_state('people') 에 [{id, name, code}] ── */
function people_list(): array
{
    static $cache = null;
    if ($cache === null) {
        $v = state_get('people');
        $cache = is_array($j = $v !== null ? json_decode($v, true) : null) ? $j : [];
    }
    return $cache;
}

function person_by(string $field, string $value): ?array
{
    foreach (people_list() as $p) {
        if (isset($p[$field]) && hash_equals((string)$p[$field], $value)) return $p;
    }
    return null;
}

/** 지금 로그인한 사람: ['role' => admin|member, 'pid' => 사람 id 또는 '', 'name' => 이름 또는 ''] */
function current_user(): ?array
{
    static $u = false;
    if ($u !== false) return $u;
    if (!auth_enabled()) return $u = ['role' => 'admin', 'pid' => '', 'name' => ''];
    $parts = explode('.', $_COOKIE[COOKIE_NAME] ?? '');
    if (count($parts) === 3) { [$role, $exp, $sig] = $parts; $pid = ''; }
    elseif (count($parts) === 4) { [$role, $exp, $pid, $sig] = $parts; }
    else return $u = null;
    if (!in_array($role, ['admin', 'member'], true) || !ctype_digit($exp)) return $u = null;
    $payload = "$role.$exp" . ($pid !== '' ? ".$pid" : '');
    if (!hash_equals(sign_payload($payload), $sig)) return $u = null;
    if ((int)$exp < time()) return $u = null;
    if ($role === 'admin' && cfg('admin_password') === '') $role = 'member';
    $name = '';
    if ($pid !== '') {
        $p = person_by('id', $pid);
        if (!$p) return $u = null;          // 입장코드를 지운 사람은 다시 들어와야 해요
        $name = (string)$p['name'];
    }
    return $u = ['role' => $role, 'pid' => $pid, 'name' => $name];
}

function current_role(): ?string
{
    return current_user()['role'] ?? null;
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
    $person = null;
    if (cfg('admin_password') !== '' && hash_equals(cfg('admin_password'), $pw)) $role = 'admin';
    elseif (cfg('app_password') !== '' && hash_equals(cfg('app_password'), $pw)) $role = 'member';
    elseif ($pw !== '' && ($person = person_by('code', $pw))) $role = 'member';
    if ($role === null) {
        q('INSERT INTO login_failures (ip, cnt, last_ts) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE cnt = VALUES(cnt), last_ts = VALUES(last_ts)',
          [$ip, $count + 1, $now]);
        throw new ApiError(401, '비밀번호가 맞지 않아요');
    }
    q('DELETE FROM login_failures WHERE ip = ?', [$ip]);
    set_session_cookie(make_token($role, $person['id'] ?? ''), SESSION_DAYS * 86400);
    return ['role' => $role, 'auth' => true, 'name' => $person['name'] ?? ''];
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
        'name' => current_user()['name'] ?? '',
        'can_edit' => can_edit($role),
        'has_admin' => cfg('admin_password') !== '',
        'server' => 'php',   // 화면이 "PDF를 브라우저에서 그림으로 바꿔 올리기" 방식으로 동작하게
    ];
}

/** 라이브 메세지·알림주기: 로그인한 팀원 누구나 */
function can_message(): bool
{
    return current_user() !== null;
}

/** 메세지에 붙일 보낸 사람 이름 */
function sender_name(): string
{
    $u = current_user();
    if (!$u) return '';
    if ($u['name'] !== '') return $u['name'];
    if (!auth_enabled()) return '';
    return $u['role'] === 'admin' ? '관리자' : '팀원';
}

// ── 입장코드 관리 (관리자) ──
function api_get_people(): array
{
    return ['people' => array_map(fn($p) => ['id' => $p['id'], 'name' => $p['name'], 'code' => $p['code']], people_list())];
}

function api_put_people(): array
{
    $out = [];
    $codes = [];
    foreach ((array)(body_json()['people'] ?? []) as $p) {
        $name = mb_substr(trim(preg_replace('/\s+/u', ' ', (string)($p['name'] ?? ''))), 0, 20);
        $code = trim((string)($p['code'] ?? ''));
        if ($name === '' && $code === '') continue;
        if ($name === '') throw new ApiError(400, "입장코드 $code 의 이름을 적어주세요");
        if (!preg_match('/^\S{4,30}$/u', $code)) throw new ApiError(400, "$name 님의 입장코드는 띄어쓰기 없이 4글자 이상이어야 해요");
        if (isset($codes[$code])) throw new ApiError(400, "입장코드 $code 가 두 번 들어 있어요");
        if ((cfg('admin_password') !== '' && hash_equals(cfg('admin_password'), $code))
            || (cfg('app_password') !== '' && hash_equals(cfg('app_password'), $code))) {
            throw new ApiError(400, "입장코드 $code 는 관리자·팀 공용 코드와 같아서 쓸 수 없어요");
        }
        $codes[$code] = true;
        $id = preg_match('/^[a-f0-9]{8}$/', (string)($p['id'] ?? '')) ? $p['id'] : bin2hex(random_bytes(4));
        $out[] = ['id' => $id, 'name' => $name, 'code' => $code];
        if (count($out) >= 50) break;
    }
    state_set('people', json_encode($out, JSON_UNESCAPED_UNICODE));
    return ['people' => $out];
}

/** 메세지 받는 사람 구분: 입장코드 사람 id / 'admin' / 'team' (팀 공용 코드) */
function recipient_key(): string
{
    $u = current_user();
    if (!$u) return '';
    if ($u['pid'] !== '') return $u['pid'];
    return $u['role'] === 'admin' ? 'admin' : 'team';
}

function api_live_recipients(): array
{
    if (!can_message()) throw new ApiError(403, '메세지를 보낼 수 없어요');
    $list = [['key' => 'admin', 'name' => '관리자']];
    foreach (people_list() as $p) $list[] = ['key' => $p['id'], 'name' => $p['name']];
    if (cfg('app_password') !== '') $list[] = ['key' => 'team', 'name' => '팀원(공용 코드)'];
    return ['recipients' => $list, 'me' => recipient_key()];
}
