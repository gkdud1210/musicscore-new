"""
카페24 서버용 config.php 만들기 → cafe24/www/config.php (git 에 안 올라감)

- DB 정보: cafe24/.secrets
- 관리자·팀원 비밀번호, 제미나이 키: 지금 맥 서버(~/ChanyangServer/backend/.env)와 같게
- secret_key: 처음에 한 번 무작위로 만들고 그다음부터는 그대로 (바꾸면 모두 다시 로그인)
값은 화면에 보여주지 않는다.
"""

import os
import re
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "cafe24" / "www" / "config.php"


def read_env(path: Path) -> dict:
    env = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                    v = v[1:-1]
                env[k.strip()] = v
    return env


def php(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


sec = read_env(ROOT / "cafe24" / ".secrets")
mac = read_env(Path.home() / "ChanyangServer" / "backend" / ".env")
missing = [k for k in ("DB_NAME", "DB_USER", "DB_PASS") if not sec.get(k)]
if missing:
    raise SystemExit(f"cafe24/.secrets 에 {', '.join(missing)} 을(를) 채워주세요")
for k in ("ADMIN_PASSWORD", "APP_PASSWORD", "GEMINI_API_KEY"):
    if not mac.get(k):
        print(f"⚠️ 맥 서버 .env 에 {k} 가 없어요 — config.php 에서 비워둘게요")

old_secret = ""
if OUT.is_file():
    m = re.search(r"'secret_key'\s*=>\s*'([^']*)'", OUT.read_text(encoding="utf-8"))
    old_secret = m.group(1) if m else ""

OUT.write_text(f"""<?php
// J&I worship 카페24 설정 — cafe24/tools/make_config.py 가 만듦. git 에 올리지 마세요.
return [
    'db_host' => {php(sec.get('DB_HOST') or 'localhost')},
    'db_name' => {php(sec['DB_NAME'])},
    'db_user' => {php(sec['DB_USER'])},
    'db_pass' => {php(sec['DB_PASS'])},
    'admin_password' => {php(mac.get('ADMIN_PASSWORD', ''))},
    'app_password' => {php(mac.get('APP_PASSWORD', ''))},
    'secret_key' => {php(old_secret or secrets.token_hex(32))},
    'gemini_api_key' => {php(mac.get('GEMINI_API_KEY', ''))},
    'gemini_model' => {php(mac.get('GEMINI_MODEL') or 'gemini-flash-latest')},
    'gemini_thinking' => 'low',
];
""", encoding="utf-8")
os.chmod(OUT, 0o600)
print(f"✅ {OUT.relative_to(ROOT)} 만들었어요 (DB: {sec['DB_NAME']}, 비밀번호·키는 맥 서버와 같게)")
