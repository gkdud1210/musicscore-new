# J&I worship — 카페24(뉴아우토반) 버전

맥 없이 카페24 웹호스팅(PHP 8 + MariaDB)에서 돌아가는 버전이에요.

- 화면은 맥 버전과 같아요 (`docs/` 를 그대로 씀).
- PDF를 올리면 **관리자 브라우저**가 페이지를 그림으로 바꿔 올리고, 서버는 페이지마다 **제미나이**에 물어봐요.
- 서버에는 페이지 그림(JPEG)만 저장해요. 원본 PDF는 저장하지 않아요 (용량 절약).
- 조 변환(파이썬 전용)은 없어요.

## 폴더

| 경로 | 내용 |
|---|---|
| `cafe24/www/api.php` | `/api/...` 요청을 받는 곳 (주소·권한 목록) |
| `cafe24/www/lib/` | DB, 로그인, 제미나이, 같은 악보 찾기, PDF 만들기, 라이브러리 기능 |
| `cafe24/www/config.sample.php` | 설정 견본 → 서버에는 `config.php` 로 |
| `cafe24/build.sh` | `docs/` + `cafe24/www/` → `cafe24/build/` |
| `cafe24/deploy.sh` | FTP로 올리기 (바뀐 파일만) |
| `cafe24/tools/export_from_mac.py` | 맥 서버의 콘티를 옮길 꾸러미로 |
| `cafe24/tools/import.sh` | 올린 꾸러미를 카페24 DB에 넣기 |

## 처음 설치 (한 번)

1. 카페24 관리 화면에서 **PHP 8.x** 로 설정하고, **DB 정보**(DB 이름 = 아이디, 비밀번호)를 확인해요.
2. `config.sample.php` 를 복사해 `config.php` 를 만들고 DB 정보, 관리자/팀원 비밀번호, `secret_key`(아무 긴 글자),
   제미나이 키를 넣어요. → `bash cafe24/deploy.sh --config <config.php 경로>`
   (config.php 는 git 에 올리지 않아요)
3. 앱 올리기: `bash cafe24/deploy.sh`
4. 맥에 있던 콘티 옮기기:
   ```
   /usr/bin/python3 cafe24/tools/export_from_mac.py ~/Desktop/jandi_export
   bash cafe24/deploy.sh ~/Desktop/jandi_export/data
   bash cafe24/tools/import.sh https://<카페24 주소>
   ```
5. 사이트에서 확인한 뒤, Cloudflare 에서 jandiworship.cloud 를 카페24로 연결해요.

## 코드 고친 뒤

`bash cafe24/deploy.sh` — 바뀐 파일만 올라가요.

## 맥에서 시험하기

```
bash cafe24/build.sh /tmp/c24     # config.php 는 직접 넣기 (db_host 127.0.0.1, db_port …)
php -S 127.0.0.1:8794 -t /tmp/c24 cafe24/tools/dev-router.php
```
