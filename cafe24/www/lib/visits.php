<?php
/**
 * 접속자 수
 *  - 화면이 열려 있는 동안 1분마다 POST /api/ping {vid} (vid = 기기마다 브라우저가 만든 무작위 값)
 *  - GET /api/visitors (관리자) → 지금 접속 중 / 오늘 / 최근 7일
 * "지금" = 최근 2분 30초 안에 신호를 보낸 기기.
 */

const ONLINE_WINDOW = 150;

function api_ping(): array
{
    $vid = (string)(body_json()['vid'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{8,40}$/', $vid)) {
        // 브라우저가 값을 못 만들면 IP+브라우저 정보로 대신
        $vid = 'h' . substr(hash('sha256', client_ip() . '|' . ($_SERVER['HTTP_USER_AGENT'] ?? '')), 0, 30);
    }
    $now = time();
    $u = current_user();
    q('INSERT INTO visits (vid, day, role, name, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_ts = VALUES(last_ts), role = VALUES(role), name = VALUES(name)',
      [$vid, date('Y-m-d', $now), (string)($u['role'] ?? ''), mb_substr((string)($u['name'] ?? ''), 0, 40), $now, $now]);
    if (random_int(1, 200) === 1) q('DELETE FROM visits WHERE day < ?', [date('Y-m-d', $now - 180 * 86400)]);
    return ['ok' => true];
}

function api_visitors(): array
{
    $now = time();
    $today = date('Y-m-d', $now);
    $online = q_all('SELECT role, name, COUNT(DISTINCT vid) AS n FROM visits WHERE last_ts > ? GROUP BY role, name', [$now - ONLINE_WINDOW]);
    $byRole = ['admin' => 0, 'member' => 0];
    $people = [];
    foreach ($online as $r) {
        $role = $r['role'] === 'admin' ? 'admin' : 'member';
        $byRole[$role] += (int)$r['n'];
        $people[] = ['name' => (string)$r['name'], 'role' => $role, 'count' => (int)$r['n']];
    }
    // 이름 있는 사람 먼저 (가나다순), 이름 없는 팀원·관리자는 뒤로
    usort($people, fn($a, $b) => [$a['name'] === '', $a['name'], $a['role']] <=> [$b['name'] === '', $b['name'], $b['role']]);
    $base = [
        'now' => $byRole['admin'] + $byRole['member'],
        'now_admin' => $byRole['admin'],
        'now_member' => $byRole['member'],
        'people' => $people,
    ];
    if (!can_edit(current_role())) return $base;
    $days = [];
    $rows = q_all('SELECT day, COUNT(*) AS n FROM visits WHERE day >= ? GROUP BY day', [date('Y-m-d', $now - 6 * 86400)]);
    $map = [];
    foreach ($rows as $r) $map[(string)$r['day']] = (int)$r['n'];
    for ($i = 6; $i >= 0; $i--) {
        $d = date('Y-m-d', $now - $i * 86400);
        $days[] = ['day' => $d, 'count' => $map[$d] ?? 0];
    }
    return $base + [
        'today' => $map[$today] ?? 0,
        'days' => $days,
    ];
}
