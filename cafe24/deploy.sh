#!/usr/bin/env bash
# 카페24에 올리기 (바뀐 파일만)
#
#   bash cafe24/deploy.sh                 ← 앱 코드(화면 + PHP)
#   bash cafe24/deploy.sh <폴더>/data     ← 맥에서 옮길 꾸러미(tools/export_from_mac.py 결과)를 www/data/ 로
#
# 접속 정보는 cafe24/.secrets 에서 읽어요 (없으면 물어봐요).
# config.php 는 따로: bash cafe24/deploy.sh --config  (cafe24/www/config.php 를 올림)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/cafe24/.ftp"

# 접속 정보: cafe24/.secrets (있으면 묻지 않고 그대로 씀) → 없으면 물어봄
SECRETS="$ROOT/cafe24/.secrets"
if [ -f "$SECRETS" ]; then set -a; . "$SECRETS"; set +a; fi
if [ -f "$STATE" ] && [ -z "${FTP_HOST:-}" ]; then . "$STATE"; fi
if [ -z "${FTP_HOST:-}" ]; then
  read -r -p "FTP 주소 (예: jandi.cafe24.com): " FTP_HOST
  read -r -p "FTP 아이디: " FTP_USER
  read -r -p "올릴 폴더 (FTP 첫 폴더가 웹 폴더면 그냥 엔터): " FTP_DIR
  printf 'FTP_HOST=%q\nFTP_USER=%q\nFTP_DIR=%q\n' "$FTP_HOST" "$FTP_USER" "${FTP_DIR:-}" > "$STATE"
fi
# 웹 폴더: 비어 있으면 FTP 첫 폴더 (카페24 뉴아우토반은 첫 폴더가 바로 웹 폴더)
FTP_BASE="ftp://$FTP_HOST/${FTP_DIR:+$FTP_DIR/}"
if [ -z "${FTP_PASS:-}" ]; then read -r -s -p "FTP 비밀번호: " FTP_PASS; echo; fi

put() {  # put <로컬 파일> <원격 경로(FTP_DIR 기준)>
  curl -sS --fail --ftp-create-dirs --ftp-pasv --retry 2 \
       --user "$FTP_USER:$FTP_PASS" -T "$1" "$FTP_BASE$2"
}

upload_tree() {  # upload_tree <로컬 폴더> <원격 하위 경로> <바뀐 것 기록 파일>
  local src="$1" prefix="$2" manifest="$3" n=0 skip=0 fail=0
  touch "$manifest"
  local new="$manifest.new"
  : > "$new"
  while IFS= read -r -d '' f; do
    local rel="${f#$src/}"
    local sum; sum="$(shasum "$f" | cut -c1-40)"
    if grep -qxF "$sum  $prefix$rel" "$manifest"; then
      echo "$sum  $prefix$rel" >> "$new"; skip=$((skip + 1)); continue
    fi
    if put "$f" "$prefix$rel"; then
      echo "$sum  $prefix$rel" >> "$new"; n=$((n + 1)); printf '  ✓ %s\n' "$prefix$rel"
    else
      fail=$((fail + 1)); printf '  ✗ %s\n' "$prefix$rel"
    fi
  done < <(find "$src" -type f ! -name '.DS_Store' ! -name 'config.php' -print0 | sort -z)
  mv "$new" "$manifest"
  echo "올림 ${n}개 · 그대로 ${skip}개 · 실패 ${fail}개"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --check)
    echo "FTP 접속 확인: ftp://$FTP_HOST/ (아이디 $FTP_USER)"
    curl -sS --fail --ftp-pasv --user "$FTP_USER:$FTP_PASS" "ftp://$FTP_HOST/" | head -20
    echo "--- 웹 폴더 ($FTP_BASE):"
    curl -sS --fail --ftp-pasv --user "$FTP_USER:$FTP_PASS" "$FTP_BASE" | head -20
    ;;
  --config)
    CFG="${2:-$ROOT/cafe24/www/config.php}"
    [ -f "$CFG" ] || { echo "config.php 가 없어요 — 먼저 python3 cafe24/tools/make_config.py"; exit 1; }
    put "$CFG" "config.php" && echo "✅ config.php 올림"
    ;;
  "")
    BUILD="$ROOT/cafe24/build"
    bash "$ROOT/cafe24/build.sh" "$BUILD" >/dev/null
    echo "앱 코드 올리는 중 → $FTP_BASE"
    upload_tree "$BUILD" "" "$ROOT/cafe24/.deploy-app"
    echo "✅ 반영 완료"
    ;;
  *)
    [ -d "$1" ] || { echo "폴더가 없어요: $1"; exit 1; }
    echo "악보 그림·DB 꾸러미 올리는 중 → ${FTP_BASE}data/"
    upload_tree "$(cd "$1" && pwd)" "data/" "$ROOT/cafe24/.deploy-data"
    echo "✅ 올림 — 이제 bash cafe24/tools/import.sh 로 DB에 넣어주세요"
    ;;
esac
