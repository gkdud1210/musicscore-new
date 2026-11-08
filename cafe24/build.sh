#!/usr/bin/env bash
# 카페24에 올릴 파일 모으기: 화면(docs/) + PHP 서버(cafe24/www/) → cafe24/build/
# 사용법: bash cafe24/build.sh [출력 폴더]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/cafe24/build}"
mkdir -p "$OUT"
# 화면: 조 변환(파이썬 전용)은 빼고
rsync -a --delete \
  --exclude 'transpose.html' --exclude 'config.php' --exclude 'data/' \
  "$ROOT/docs/" "$OUT/"
# PHP 서버 (config.php, data/ 는 서버에 있는 것을 그대로 둔다)
rsync -a --exclude 'config.php' --exclude 'data/*' "$ROOT/cafe24/www/" "$OUT/"
mkdir -p "$OUT/data"
cp "$ROOT/cafe24/www/data/.htaccess" "$OUT/data/.htaccess"
echo "✅ $OUT 에 모았어요"
