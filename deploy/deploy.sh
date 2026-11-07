#!/usr/bin/env bash
# ============================================================
#  찬양악보 라이브러리 — 맥에서 서버로 앱 코드 올리기 (업데이트할 때마다 실행)
#    bash deploy/deploy.sh <서버IP> [도메인]
#  - 처음이면 서버 설치(setup-server.sh)까지 자동으로 진행
#  - 업로드한 악보/DB(storage)와 서버의 .env(비밀번호)는 절대 덮어쓰지 않음
# ============================================================
set -euo pipefail

HOST="${1:?사용법: bash deploy/deploy.sh <서버IP> [도메인]}"
DOMAIN="${2:-jandiworship.cloud}"
KEY="${SSH_KEY:-$HOME/.ssh/oracle_chanyang}"
SSH_USER="${SSH_USER:-ubuntu}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST")

echo "▶ 서버 연결 확인"
"${SSH[@]}" true

if ! "${SSH[@]}" test -f /etc/systemd/system/chanyang.service; then
  echo "▶ 처음 설치 — 서버 준비 (5~10분)"
  scp -i "$KEY" "$ROOT/deploy/setup-server.sh" "$SSH_USER@$HOST:/tmp/setup-server.sh"
  "${SSH[@]}" "sudo bash /tmp/setup-server.sh '$DOMAIN'"
fi

echo "▶ 코드 올리기"
rsync -az --delete -e "ssh -i $KEY" \
  --exclude 'storage/' --exclude '.env' --exclude '__pycache__/' --exclude '*.pyc' --exclude 'venv/' \
  "$ROOT/backend" "$ROOT/docs" "$SSH_USER@$HOST:/opt/chanyang/app/"

echo "▶ 파이썬 패키지 설치/업데이트"
"${SSH[@]}" "/opt/chanyang/venv/bin/pip install -q -r /opt/chanyang/app/backend/requirements.txt"

echo "▶ 서비스 재시작"
"${SSH[@]}" "sudo systemctl restart chanyang && sudo systemctl reload caddy || sudo systemctl restart caddy"

echo "▶ 동작 확인"
for i in $(seq 1 30); do
  if "${SSH[@]}" "curl -sf http://127.0.0.1:8000/health >/dev/null"; then
    echo "✅ 배포 완료: https://$DOMAIN"
    exit 0
  fi
  sleep 2
done
echo "⚠️ 서버가 응답하지 않아요. 로그: ssh -i $KEY $SSH_USER@$HOST 'sudo journalctl -u chanyang -n 50'"
exit 1
