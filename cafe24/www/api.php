<?php
/**
 * /api/... 요청을 받아서 알맞은 함수로 보낸다 (.htaccess 가 /api/* 를 여기로 보냄)
 *
 * 권한: 로그인 안 하면 login/logout/me/health 만.
 *       읽기(GET)는 팀원 OK. 쓰기는 관리자만 — 단, 아래 member_ok 표시된 것(PDF 받기, 필기, 즐겨찾기, NOW)은 팀원도.
 */

require __DIR__ . '/lib/boot.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/music.php';
require __DIR__ . '/lib/gemini.php';
require __DIR__ . '/lib/dedupe.php';
require __DIR__ . '/lib/pdf.php';
require __DIR__ . '/lib/library.php';
require __DIR__ . '/lib/admin.php';
require __DIR__ . '/lib/visits.php';

// [메서드, 주소 패턴, 함수, 누구(public | member | member_ok | admin)]
// member = 팀원도 볼 수 있는 읽기, member_ok = 팀원도 할 수 있는 쓰기, admin = 관리자만
$ROUTES = [
    ['GET', '#^/health$#', fn() => ['status' => 'ok'], 'public'],
    ['POST', '#^/login$#', 'api_login', 'public'],
    ['POST', '#^/logout$#', 'api_logout', 'public'],
    ['GET', '#^/me$#', 'api_me', 'public'],

    ['GET', '#^/ai-status$#', 'api_ai_status', 'member'],
    ['GET', '#^/scores$#', 'api_list_scores', 'member'],
    ['POST', '#^/scores$#', 'api_create_score', 'admin'],
    ['GET', '#^/scores/(\d+)$#', fn($id) => summary_by_id($id, true), 'member'],
    ['PATCH', '#^/scores/(\d+)$#', 'api_update_score', 'admin'],
    ['DELETE', '#^/scores/(\d+)$#', 'api_delete_score', 'admin'],
    ['POST', '#^/scores/(\d+)/confirm$#', 'api_confirm_score', 'admin'],
    ['POST', '#^/scores/(\d+)/pages/(\d+)$#', 'api_upload_page', 'admin'],
    ['POST', '#^/scores/(\d+)/pages/(\d+)/read$#', 'api_read_page', 'admin'],
    ['POST', '#^/scores/(\d+)/finish$#', 'api_finish_score', 'admin'],
    ['POST', '#^/scores/(\d+)/fail$#', 'api_fail_score', 'admin'],
    ['POST', '#^/scores/(\d+)/reprocess$#', 'api_reprocess_score', 'admin'],
    ['POST', '#^/scores/(\d+)/songs$#', 'api_add_song', 'admin'],
    ['GET', '#^/scores/(\d+)/thumbnail$#', 'api_thumbnail', 'member'],
    ['GET', '#^/scores/(\d+)/pages/(\d+)/image$#', 'api_page_image', 'member'],
    ['GET', '#^/scores/(\d+)/file$#', fn($id) => api_score_pdf($id, false), 'member'],
    ['GET', '#^/scores/(\d+)/export$#', fn($id) => api_score_pdf($id, true), 'member'],
    ['GET', '#^/scores/(\d+)/annotations/(\d+)$#', 'api_get_annotations', 'member'],
    ['PUT', '#^/scores/(\d+)/annotations/(\d+)$#', 'api_put_annotations', 'member_ok'],
    ['POST', '#^/scores/(\d+)/analyze-page/(\d+)$#', fn() => throw new ApiError(501, '조 변환은 이 서버에서 지원하지 않아요'), 'member_ok'],

    ['GET', '#^/songs$#', 'api_search_songs', 'member'],
    ['GET', '#^/songs/facets$#', 'api_song_facets', 'member'],
    ['GET', '#^/songs/(\d+)$#', 'api_get_song', 'member'],
    ['PATCH', '#^/songs/(\d+)$#', 'api_update_song', 'admin'],
    ['DELETE', '#^/songs/(\d+)$#', 'api_delete_song', 'admin'],
    ['POST', '#^/songs/(\d+)/merge-prev$#', 'api_merge_prev', 'admin'],
    ['POST', '#^/songs/(\d+)/split$#', 'api_split_song', 'admin'],
    ['POST', '#^/songs/(\d+)/remove-page$#', 'api_remove_page', 'admin'],
    ['POST', '#^/songs/(\d+)/keep$#', 'api_keep_sheet', 'admin'],
    ['POST', '#^/songs/(\d+)/restore$#', 'api_restore_sheet', 'admin'],

    ['POST', '#^/setlist/export$#', 'api_export_setlist', 'member_ok'],
    ['GET', '#^/marks$#', 'api_get_marks', 'member'],
    ['POST', '#^/marks$#', 'api_set_marks', 'member_ok'],
    ['GET', '#^/live$#', 'api_get_live', 'member'],
    ['POST', '#^/live$#', 'api_start_live', 'member_ok'],
    ['DELETE', '#^/live$#', 'api_stop_live', 'member_ok'],
    ['GET', '#^/services$#', 'api_list_services', 'member'],
    ['GET', '#^/services/(\d{4}-\d{2}-\d{2})$#', 'api_get_service', 'member'],
    ['PUT', '#^/services/(\d{4}-\d{2}-\d{2})$#', 'api_put_service', 'admin'],
    ['DELETE', '#^/services/(\d{4}-\d{2}-\d{2})$#', 'api_delete_service', 'admin'],

    ['POST', '#^/ping$#', 'api_ping', 'member_ok'],
    ['GET', '#^/visitors$#', 'api_visitors', 'admin'],

    ['POST', '#^/admin/import$#', 'api_admin_import', 'admin'],
    ['POST', '#^/admin/rehash$#', 'api_admin_rehash', 'admin'],
];

function route_path(): string
{
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    if ($uri === '/health') return '/health';
    $pos = strpos($uri, '/api/');
    return $pos === false ? '/' : substr($uri, $pos + 4);
}

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'HEAD') $method = 'GET';
    $path = route_path();
    $found = null;
    $allowed = false;
    foreach ($ROUTES as [$m, $pat, $fn, $who]) {
        if (!preg_match($pat, $path, $mm)) continue;
        $allowed = true;
        if ($m !== $method) continue;
        $found = [$fn, $who, array_map(fn($v) => ctype_digit($v) ? (int)$v : $v, array_slice($mm, 1))];
        break;
    }
    if (!$found) throw new ApiError($allowed ? 405 : 404, $allowed ? '지원하지 않는 요청이에요' : '없는 주소예요');
    [$fn, $who, $args] = $found;
    if ($who !== 'public') {
        $role = current_role();
        if ($role === null) throw new ApiError(401, '로그인이 필요합니다');
        if ($who === 'admin' && !can_edit($role)) throw new ApiError(403, '관리자만 할 수 있어요 (업로드·수정·삭제)');
    }
    $result = $fn(...$args);
    if ($result !== null) send_json($result);
} catch (ApiError $e) {
    if (!headers_sent()) send_json(['detail' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log('[jandi] ' . $e);
    if (!headers_sent()) send_json(['detail' => '서버 오류: ' . $e->getMessage()], 500);
}
