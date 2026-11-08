<?php
// 맥에서 시험할 때만: php -S 127.0.0.1:8794 -t cafe24/build cafe24/tools/dev-router.php
// (.htaccess 대신 같은 규칙을 흉내낸다)
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(lib|data)(/|$)#', $path) || preg_match('#^/config(\.sample)?\.php$#', $path)) {
    http_response_code(403);
    echo 'Forbidden';
    return true;
}
if (str_starts_with($path, '/api/') || $path === '/health') {
    require $_SERVER['DOCUMENT_ROOT'] . '/api.php';
    return true;
}
if ($path === '/') $_SERVER['SCRIPT_NAME'] = '/index.html';
return false;
