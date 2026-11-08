#!/usr/bin/env bash
# 카페24에 올리기 (바뀐 파일만)
#
#   bash cafe24/deploy.sh                 ← 앱 코드(화면 + PHP)
#   bash cafe24/deploy.sh <폴더>/data     ← 맥에서 옮길 꾸러미(tools/export_from_mac.py 결과)를 www/data/ 로
#
# FTP 정보는 처음 한 번 물어보고 cafe24/.ftp 에 저장해요 (비밀번호는 저장 안 함 — 매번 입력).
# config.php 는 올리지 않아요 → 처음에 한 번만 직접 올리기: bash cafe24/deploy.sh --config <config.php 경로>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/cafe24/.ftp"

if [ -f "$STATE" ]; then . "$STATE"; fi
if [ -z "${FTP_HOST:-}" ]; then
  read -r -p "FTP 주소 (예: jandi.cafe24.com): " FTP_HOST
  read -r -p "FTP 아이디: " FTP_USER
  read -r -p "올릴 폴더 (보통 www — 모르면 그냥 엔터): " FTP_DIR
  FTP_DIR="${FTP_DIR:-www}"
  printf 'FTP_HOST=%q\nFTP_USER=%q\nFTP_DIR=%q\n' "$FTP_HOST" "$FTP_USER" "$FTP_DIR" > "$STATE"
fi
read -r -s -p "FTP 비밀번호: " FTP_PASS; echo

put() {  # put <로컬 파일> <원격 경로(FTP_DIR 기준)>
  curl -sS --fail --ftp-create-dirs --ftp-pasv --retry 2 \
       --user "$FTP_USER:$FTP_PASS" -T "$1" "ftp://$FTP_HOST/$FTP_DIR/$2"
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
  echo "올림 $n개 · 그대로 $skip개 · 실패 $fail개"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --config)
    [ -f "${2:-}" ] || { echo "config.php 경로를 적어주세요"; exit 1; }
    put "$2" "config.php" && echo "✅ config.php 올림"
    ;;
  "")
    BUILD="$ROOT/cafe24/build"
    bash "$ROOT/cafe24/build.sh" "$BUILD" >/dev/null
    echo "앱 코드 올리는 중 → ftp://$FTP_HOST/$FTP_DIR/"
    upload_tree "$BUILD" "" "$ROOT/cafe24/.deploy-app"
    echo "✅ 반영 완료"
    ;;
  *)
    [ -d "$1" ] || { echo "폴더가 없어요: $1"; exit 1; }
    echo "악보 그림·DB 꾸러미 올리는 중 → ftp://$FTP_HOST/$FTP_DIR/data/"
    upload_tree "$(cd "$1" && pwd)" "data/" "$ROOT/cafe24/.deploy-data"
    echo "✅ 올림 — 이제 bash cafe24/tools/import.sh 로 DB에 넣어주세요"
    ;;
esac
