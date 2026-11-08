#!/usr/bin/env bash
# 카페24에 올린 꾸러미(data/import.json + 그림)를 DB에 넣고, 같은 악보 찾기용 지문을 만든다. (처음 한 번)
#   bash cafe24/tools/import.sh https://jandi.cafe24.com
set -euo pipefail
SITE="${1:-}"
[ -n "$SITE" ] || read -r -p "사이트 주소 (예: https://jandi.cafe24.com): " SITE
SITE="${SITE%/}"
read -r -s -p "관리자 비밀번호: " PW; echo
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
body=$(python3 -c 'import json,sys; print(json.dumps({"password": sys.argv[1]}))' "$PW")
curl -sS --fail-with-body -c "$JAR" -H 'content-type: application/json' -d "$body" "$SITE/api/login" >/dev/null \
  || { echo "로그인 실패"; exit 1; }
echo "DB에 넣는 중..."
curl -sS --fail-with-body -b "$JAR" -X POST "$SITE/api/admin/import"; echo
echo "같은 악보 찾기용 지문 만드는 중..."
while :; do
  r=$(curl -sS --fail-with-body -b "$JAR" -X POST "$SITE/api/admin/rehash")
  echo "  $r"
  echo "$r" | grep -q '"remaining":0' && break
done
echo "✅ 끝 — $SITE 에서 확인해보세요"
