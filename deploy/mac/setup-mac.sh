#!/usr/bin/env bash
# ============================================================
#  이 맥북을 찬양악보 라이브러리 서버로 만들기 (Cloudflare 터널, 무료)
#    bash deploy/mac/setup-mac.sh
#
#  하는 일:
#   1) 앱을 ~/ChanyangServer 로 복사 (다운로드 폴더는 macOS 보호 폴더라 백그라운드 실행이 막힐 수 있음)
#      + 지금까지 올린 악보/DB를 함께 옮김
#   2) 맥이 켜지면 앱이 자동 실행되도록 등록 (멈추면 자동 재시작)
#   3) Cloudflare 터널 연결 → https://jandiworship.cloud 로 접속 가능
#   4) 매일 새벽 4시 자동 백업 (최근 14일 보관)
#  다시 실행해도 안전합니다 (이미 된 단계는 건너뜀).
# ============================================================
set -euo pipefail

DOMAIN="${DOMAIN:-jandiworship.cloud}"
TUNNEL_NAME="${TUNNEL_NAME:-jandiworship}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="$HOME/ChanyangServer"
PY=/usr/bin/python3
CLOUDFLARED="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/chanyang"
UID_NUM="$(id -u)"
APP_LABEL=cloud.jandiworship.app
TUNNEL_LABEL=cloud.jandiworship.tunnel
BACKUP_LABEL=cloud.jandiworship.backup

mkdir -p "$SERVER/backend/storage" "$SERVER/backups" "$LA" "$LOGS"

load_agent() {  # $1=label  (이미 등록돼 있으면 내렸다가 다시 올림)
  launchctl bootout "gui/$UID_NUM/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$LA/$1.plist"
}

# ── 1. 앱 복사 + 데이터 옮기기 ───────────────────────────────
echo "▶ 1/4 앱을 $SERVER 로 복사"
rsync -a --delete --exclude 'storage/' --exclude '__pycache__/' --exclude '.env' \
  "$REPO/backend" "$REPO/docs" "$SERVER/"
if [ ! -f "$SERVER/backend/.env" ]; then
  cp "$REPO/backend/.env" "$SERVER/backend/.env"
  chmod 600 "$SERVER/backend/.env"
fi
if [ ! -f "$SERVER/backend/storage/library.db" ] && [ -f "$REPO/backend/storage/library.db" ]; then
  echo "  지금까지 올린 악보와 DB를 옮기는 중..."
  rsync -a --exclude 'library.db*' "$REPO/backend/storage/" "$SERVER/backend/storage/"
  sqlite3 "$REPO/backend/storage/library.db" ".backup '$SERVER/backend/storage/library.db'"
fi

# ── 2. 앱 자동 실행 등록 ─────────────────────────────────────
echo "▶ 2/4 앱 자동 실행 등록"
# 임시로 켜둔 서버가 8000번 포트를 쓰고 있으면 끈다
for PID in $(lsof -ti tcp:8000 -sTCP:LISTEN 2>/dev/null); do kill "$PID" 2>/dev/null || true; done
sleep 1
cat > "$LA/$APP_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$APP_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string><string>-m</string><string>uvicorn</string><string>app:app</string>
    <string>--host</string><string>127.0.0.1</string><string>--port</string><string>8000</string>
    <string>--proxy-headers</string><string>--forwarded-allow-ips</string><string>127.0.0.1</string>
  </array>
  <key>WorkingDirectory</key><string>$SERVER/backend</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOGS/app.log</string>
  <key>StandardErrorPath</key><string>$LOGS/app.log</string>
</dict>
</plist>
EOF
load_agent "$APP_LABEL"
printf "  앱 시작 기다리는 중"
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null; then echo " ✅"; break; fi
  printf "."; sleep 1
  if [ "$i" = 60 ]; then echo; echo "⚠️ 앱이 시작되지 않았어요. 로그: tail -50 $LOGS/app.log"; exit 1; fi
done

# ── 3. Cloudflare 터널 ───────────────────────────────────────
echo "▶ 3/4 Cloudflare 터널 연결 ($DOMAIN)"
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "  브라우저가 열리면 Cloudflare에 로그인하고 '$DOMAIN' 을 선택한 뒤 'Authorize'를 눌러주세요."
  "$CLOUDFLARED" tunnel login
fi
if ! "$CLOUDFLARED" tunnel info "$TUNNEL_NAME" >/dev/null 2>&1; then
  "$CLOUDFLARED" tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID="$("$CLOUDFLARED" tunnel list -o json | "$PY" -c "
import sys, json
for t in json.load(sys.stdin):
    if t['name'] == '$TUNNEL_NAME':
        print(t['id'])
")"
"$CLOUDFLARED" tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$DOMAIN"
"$CLOUDFLARED" tunnel route dns --overwrite-dns "$TUNNEL_NAME" "www.$DOMAIN"
cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $DOMAIN
    service: http://127.0.0.1:8000
  - hostname: www.$DOMAIN
    service: http://127.0.0.1:8000
  - service: http_status:404
EOF
cat > "$LA/$TUNNEL_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED</string><string>tunnel</string><string>--config</string>
    <string>$HOME/.cloudflared/config.yml</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOGS/tunnel.log</string>
</dict>
</plist>
EOF
load_agent "$TUNNEL_LABEL"

# ── 4. 매일 자동 백업 ────────────────────────────────────────
echo "▶ 4/4 매일 자동 백업 등록 (새벽 4시, 최근 14일 보관 → $SERVER/backups)"
cat > "$SERVER/backup.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SRC="$HOME/ChanyangServer/backend/storage"
DST="$HOME/ChanyangServer/backups"
TODAY=$(date +%F)
PREV=$(ls -1d "$DST"/20* 2>/dev/null | tail -1 || true)
mkdir -p "$DST/$TODAY"
rsync -a --delete --exclude 'library.db*' --exclude 'pages/' ${PREV:+--link-dest="$PREV/files"} "$SRC/" "$DST/$TODAY/files/"
[ -f "$SRC/library.db" ] && sqlite3 "$SRC/library.db" ".backup '$DST/$TODAY/library.db'"
COUNT=$(ls -1d "$DST"/20* | wc -l | tr -d ' ')
if [ "$COUNT" -gt 14 ]; then
  ls -1d "$DST"/20* | sort | head -n "$((COUNT - 14))" | while read -r OLD; do rm -rf "$OLD"; done
fi
EOF
chmod +x "$SERVER/backup.sh"
cat > "$LA/$BACKUP_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$BACKUP_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SERVER/backup.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOGS/backup.log</string>
  <key>StandardErrorPath</key><string>$LOGS/backup.log</string>
</dict>
</plist>
EOF
load_agent "$BACKUP_LABEL"
bash "$SERVER/backup.sh" && echo "  첫 백업 완료"

echo
echo "✅ 완료! 몇 분 뒤 https://$DOMAIN 에 접속해보세요."
echo "   (DNS 반영에 몇 분 걸릴 수 있어요)"
echo "   로그: $LOGS"
