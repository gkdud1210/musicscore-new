#!/usr/bin/env bash
# 코드를 고친 뒤 맥 서버(~/ChanyangServer)에 반영: bash deploy/mac/update-mac.sh
# 업로드한 악보/DB(storage)와 비밀번호(.env)는 건드리지 않음
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="$HOME/ChanyangServer"
[ -d "$SERVER/backend" ] || { echo "먼저 bash deploy/mac/setup-mac.sh 를 실행하세요"; exit 1; }
rsync -a --delete --exclude 'storage/' --exclude '__pycache__/' --exclude '.env' \
  "$REPO/backend" "$REPO/docs" "$SERVER/"
launchctl kickstart -k "gui/$(id -u)/cloud.jandiworship.app"
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:8000/health >/dev/null && { echo "✅ 반영 완료"; exit 0; }
  sleep 1
done
echo "⚠️ 앱이 다시 시작되지 않았어요: tail -50 ~/Library/Logs/chanyang/app.log"
exit 1
