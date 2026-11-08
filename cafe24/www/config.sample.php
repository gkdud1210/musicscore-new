<?php
/**
 * J&I worship — 카페24 설정 파일 견본
 * 이 파일을 복사해서 config.php 로 저장하고 값을 넣으세요. (config.php 는 git 에 올라가지 않아요)
 */
return [
    // 카페24 MySQL(MariaDB) — 호스팅 관리 > DB 정보에서 확인
    'db_host' => 'localhost',
    'db_name' => '',
    'db_user' => '',
    'db_pass' => '',

    // 로그인 비밀번호: 관리자(업로드·수정·삭제), 팀원(보기·담기·PDF·즐겨찾기·NOW)
    'admin_password' => '',
    'app_password' => '',

    // 로그인 쿠키 서명용 아무 긴 문자열 (바꾸면 모두 다시 로그인)
    'secret_key' => '',

    // 제미나이 — https://aistudio.google.com/apikey
    'gemini_api_key' => '',
    'gemini_model' => 'gemini-flash-latest',
    'gemini_thinking' => 'low',
];
