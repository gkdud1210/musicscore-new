#!/usr/bin/env bash
# 카페24에 올린 꾸러미(data/import.json + 그림)를 DB에 넣고, 같은 악보 찾기용 지문을 만든다. (처음 한 번)
#   bash cafe24/tools/import.sh   (주소는 cafe24/.secrets 의 SITE_URL)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "$ROOT/cafe24/.secrets" ]; then set -a; . "$ROOT/cafe24/.secrets"; set +a; fi
SITE="${1:-${SITE_URL:-}}"
[ -n "$SITE" ] || read -r -p "사이트 주소 (예: https://jandi.cafe24.com): " SITE
SITE="${SITE%/}"
# 관리자 비밀번호: 맥 서버와 같은 것 (없으면 물어봄)
PW="$(grep -E '^ADMIN_PASSWORD=' "$HOME/ChanyangServer/backend/.env" 2>/dev/null | cut -d= -f2- || true)"
[ -n "$PW" ] || { read -r -s -p "관리자 비밀번호: " PW; echo; }
# 도메인을 아직 카페24로 옮기기 전이면 SITE_IP(카페24 서버 IP)로 직접 접속
RESOLVE=()
if [ -n "${SITE_IP:-}" ]; then
  host="${SITE#*://}"; host="${host%%/*}"
  RESOLVE=(--resolve "$host:80:$SITE_IP" --resolve "$host:443:$SITE_IP")
fi
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
body=$(python3 -c 'import json,sys; print(json.dumps({"password": sys.argv[1]}))' "$PW")
curl -sS --fail-with-body "${RESOLVE[@]}" -c "$JAR" -H 'content-type: application/json' -d "$body" "$SITE/api/login" >/dev/null \
  || { echo "로그인 실패"; exit 1; }
echo "DB에 넣는 중..."
curl -sS --fail-with-body "${RESOLVE[@]}" -b "$JAR" -X POST -H "content-type: application/json" -d "{}" "$SITE/api/admin/import"; echo
echo "같은 악보 찾기용 지문 만드는 중..."
while :; do
  r=$(curl -sS --fail-with-body "${RESOLVE[@]}" -b "$JAR" -X POST -H "content-type: application/json" -d "{}" "$SITE/api/admin/rehash")
  echo "  $r"
  echo "$r" | grep -q '"remaining":0' && break
done
echo "✅ 끝 — $SITE 에서 확인해보세요"
