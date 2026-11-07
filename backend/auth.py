"""
공용 비밀번호 로그인

환경 변수:
  APP_PASSWORD    팀원용 비밀번호. 설정하면 로그인해야 앱을 쓸 수 있다.
                  (비워두면 로그인 없이 누구나 사용 — 내 컴퓨터에서만 쓸 때)
  ADMIN_PASSWORD  관리자 비밀번호 (선택). 설정하면 업로드/수정/삭제는 관리자만 할 수 있다.
                  팀원은 검색·악보 보기·새 콘티 PDF 내보내기·필기만 가능.
  SECRET_KEY      로그인 쿠키 서명 키 (선택). 비우면 비밀번호로부터 만든다.
                  → 비밀번호를 바꾸면 기존 로그인이 모두 풀린다.

로그인 상태는 서명된 HttpOnly 쿠키로 유지한다 (기본 180일 — 홈 화면 앱에서 매번 로그인하지 않도록).
"""

import hashlib
import hmac
import logging
import os
import re
import time
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

COOKIE_NAME = "scoreshift_session"
SESSION_DAYS = 180

# 로그인 없이 열 수 있는 경로 (로그인 화면과 홈 화면 앱 설치에 필요한 파일들)
PUBLIC_PATHS = {
    "/login.html", "/api/login", "/api/logout", "/api/me", "/health",
    "/manifest.webmanifest", "/sw.js", "/favicon.ico",
}
PUBLIC_PREFIXES = ("/icons/", "/css/")

# 팀원도 할 수 있는 "쓰기" 요청 (나머지 쓰기 요청은 관리자 전용)
MEMBER_WRITE_PATTERNS = [
    re.compile(r"^/api/setlist/export$"),
    re.compile(r"^/api/scores/\d+/annotations/\d+$"),
    re.compile(r"^/api/scores/\d+/analyze-page/\d+$"),
    re.compile(r"^/(analyze|transpose|omr-analyze)$"),
]

_failures: dict = {}  # ip -> [실패 횟수, 마지막 실패 시각] (무차별 대입 방지)


def _app_password() -> str:
    return os.getenv("APP_PASSWORD", "").strip()


def _admin_password() -> str:
    return os.getenv("ADMIN_PASSWORD", "").strip()


def auth_enabled() -> bool:
    return bool(_app_password() or _admin_password())


def _secret() -> bytes:
    base = os.getenv("SECRET_KEY", "").strip() or f"{_app_password()}|{_admin_password()}"
    return hashlib.sha256(("scoreshift:" + base).encode()).digest()


def _sign(payload: str) -> str:
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def make_token(role: str) -> str:
    payload = f"{role}.{int(time.time()) + SESSION_DAYS * 86400}"
    return f"{payload}.{_sign(payload)}"


def role_from_request(request: Request) -> Optional[str]:
    """'admin' | 'member' | None(로그인 안 됨). 인증이 꺼져 있으면 모두 admin."""
    if not auth_enabled():
        return "admin"
    token = request.cookies.get(COOKIE_NAME, "")
    parts = token.split(".")
    if len(parts) != 3:
        return None
    role, exp, sig = parts
    if role not in ("admin", "member") or not exp.isdigit():
        return None
    if not hmac.compare_digest(sig, _sign(f"{role}.{exp}")):
        return None
    if int(exp) < time.time():
        return None
    if role == "admin" and not _admin_password():
        role = "member"  # 관리자 비밀번호를 없앴으면 관리자 세션도 팀원으로 취급
    return role


def _needs_admin(method: str, path: str) -> bool:
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    return not any(p.match(path) for p in MEMBER_WRITE_PATTERNS)


def _is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES)


async def auth_middleware(request: Request, call_next):
    if not auth_enabled():
        return await call_next(request)

    path = request.url.path
    if _is_public(path):
        return await call_next(request)

    role = role_from_request(request)
    if role is None:
        if path.startswith("/api/") or request.method != "GET" or not _wants_html(request, path):
            return JSONResponse({"detail": "로그인이 필요합니다"}, status_code=401)
        nxt = path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/login.html?next={_quote(nxt)}", status_code=303)

    # 관리자 비밀번호를 설정한 경우에만 관리자/팀원 권한을 나눈다
    if _admin_password() and role != "admin" and _needs_admin(request.method, path):
        return JSONResponse({"detail": "관리자만 할 수 있어요 (업로드·수정·삭제)"}, status_code=403)

    return await call_next(request)


def _wants_html(request: Request, path: str) -> bool:
    return path == "/" or path.endswith(".html") or "text/html" in request.headers.get("accept", "")


def _quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="/?=&")


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")


def _is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "") == "https"


# ═══════════════════════════════════════════════════════════════
#   로그인 / 로그아웃 / 내 권한
# ═══════════════════════════════════════════════════════════════

class LoginRequest(BaseModel):
    password: str


@router.post("/login")
def login(req: LoginRequest, request: Request):
    if not auth_enabled():
        return {"role": "admin", "auth": False}

    ip = _client_ip(request)
    count, last = _failures.get(ip, [0, 0])
    if count >= 5 and time.time() - last < 60:
        return JSONResponse({"detail": "비밀번호를 여러 번 틀렸어요. 1분 뒤에 다시 시도해주세요."}, status_code=429)

    pw = (req.password or "").strip()
    role = None
    if _admin_password() and hmac.compare_digest(pw.encode(), _admin_password().encode()):
        role = "admin"
    elif _app_password() and hmac.compare_digest(pw.encode(), _app_password().encode()):
        role = "member"

    if role is None:
        _failures[ip] = [count + 1, time.time()]
        logger.warning(f"🔒 로그인 실패 ({ip})")
        return JSONResponse({"detail": "비밀번호가 맞지 않아요"}, status_code=401)

    _failures.pop(ip, None)
    resp = JSONResponse({"role": role, "auth": True})
    resp.set_cookie(
        COOKIE_NAME, make_token(role),
        max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=_is_https(request), path="/",
    )
    logger.info(f"🔓 로그인 ({role}, {ip})")
    return resp


@router.post("/logout")
def logout():
    resp = JSONResponse({"success": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@router.get("/me")
def me(request: Request):
    role = role_from_request(request)
    return {
        "auth": auth_enabled(),
        "role": role,
        # 관리자 비밀번호가 따로 있을 때만 팀원/관리자 구분이 의미 있음
        "can_edit": role == "admin" or (role == "member" and not _admin_password()),
        "has_admin": bool(_admin_password()),
    }
