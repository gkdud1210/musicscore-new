#!/usr/bin/env bash
# ============================================================
#  J&I worship — 서버 첫 설치 스크립트 (Ubuntu 22.04/24.04)
#  서버에서 한 번만 실행:  sudo bash setup-server.sh jandiworship.cloud
#
#  하는 일:
#   1) 메모리가 작으면 swap 추가
#   2) Python, Tesseract OCR(한국어), Caddy(웹서버 + https 자동 발급) 설치
#   3) 방화벽(iptables)에서 80/443 포트 열기 (Oracle Ubuntu 이미지는 기본으로 막혀 있음)
#   4) 앱 전용 사용자 / 폴더 / 파이썬 가상환경 준비
#   5) systemd 서비스(자동 시작·자동 재시작), Caddy 설정, 매일 자동 백업 등록
#  앱 코드는 deploy.sh가 /opt/chanyang/app 으로 올린다.
# ============================================================
set -euo pipefail

DOMAIN="${1:?사용법: sudo bash setup-server.sh <도메인>}"
APP_ROOT=/opt/chanyang
APP_DIR=$APP_ROOT/app
APP_USER=chanyang

echo "▶ 1/6 swap 확인"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 3000 ] && ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  swap 2GB 추가 (메모리 ${MEM_MB}MB)"
fi

echo "▶ 2/6 패키지 설치"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3-venv python3-pip python3-dev build-essential \
  tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng \
  sqlite3 rsync curl gnupg iptables-persistent netfilter-persistent
if ! apt-get install -y caddy; then
  # Ubuntu 22.04 등 기본 저장소에 caddy가 없으면 공식 저장소 추가
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "▶ 3/6 방화벽 80/443 열기"
for PORT in 80 443; do
  if ! iptables -C INPUT -p tcp --dport $PORT -m state --state NEW -j ACCEPT 2>/dev/null; then
    REJECT_LINE=$(iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
    if [ -n "${REJECT_LINE:-}" ]; then
      iptables -I INPUT "$REJECT_LINE" -p tcp --dport $PORT -m state --state NEW -j ACCEPT
    else
      iptables -A INPUT -p tcp --dport $PORT -m state --state NEW -j ACCEPT
    fi
  fi
done
netfilter-persistent save

echo "▶ 4/6 앱 사용자 / 폴더 / 가상환경"
id -u $APP_USER >/dev/null 2>&1 || useradd --system --home $APP_ROOT --shell /usr/sbin/nologin $APP_USER
mkdir -p $APP_DIR/backend/storage $APP_ROOT/backups
[ -d $APP_ROOT/venv ] || python3 -m venv $APP_ROOT/venv
$APP_ROOT/venv/bin/pip install --upgrade pip wheel >/dev/null
# 배포 계정(ubuntu)이 코드를 올릴 수 있게, 데이터(storage)는 앱 사용자만 쓰게
chown -R "${SUDO_USER:-ubuntu}":"${SUDO_USER:-ubuntu}" $APP_DIR
chown -R $APP_USER:$APP_USER $APP_DIR/backend/storage $APP_ROOT/backups

if [ ! -f $APP_DIR/backend/.env ]; then
  cat > $APP_DIR/backend/.env <<EOF
# 비밀번호는 'sudo nano $APP_DIR/backend/.env' 로 바꾸고 'sudo systemctl restart chanyang'
APP_PASSWORD=
ADMIN_PASSWORD=
SECRET_KEY=$(openssl rand -hex 32)
ANTHROPIC_API_KEY=
EOF
fi
chown root:$APP_USER $APP_DIR/backend/.env
chmod 640 $APP_DIR/backend/.env

echo "▶ 5/6 서비스 등록"
cat > /etc/systemd/system/chanyang.service <<EOF
[Unit]
Description=J&I worship
After=network.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$APP_DIR/backend/.env
ExecStart=$APP_ROOT/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips 127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	request_body {
		max_size 110MB
	}
	reverse_proxy 127.0.0.1:8000
}

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
EOF

echo "▶ 6/6 매일 자동 백업 (새벽 4시, 최근 14일 보관)"
cat > $APP_ROOT/backup.sh <<'EOF'
#!/usr/bin/env bash
# DB는 sqlite 온라인 백업으로 안전하게 복사, PDF 등 파일은 하드링크 스냅샷(용량 절약)
set -euo pipefail
SRC=/opt/chanyang/app/backend/storage
DST=/opt/chanyang/backups
TODAY=$(date +%F)
PREV=$(ls -1d $DST/20* 2>/dev/null | tail -1 || true)
mkdir -p "$DST/$TODAY"
rsync -a --delete --exclude 'library.db*' --exclude 'pages/' ${PREV:+--link-dest="$PREV/files"} "$SRC/" "$DST/$TODAY/files/"
[ -f "$SRC/library.db" ] && sqlite3 "$SRC/library.db" ".backup '$DST/$TODAY/library.db'"
ls -1d $DST/20* | head -n -14 | xargs -r rm -rf
EOF
chmod +x $APP_ROOT/backup.sh
chown $APP_USER:$APP_USER $APP_ROOT/backup.sh
echo "0 4 * * * $APP_USER $APP_ROOT/backup.sh" > /etc/cron.d/chanyang-backup

systemctl daemon-reload
systemctl enable chanyang caddy >/dev/null
echo "✅ 서버 준비 완료. 이제 맥에서 deploy.sh 로 앱 코드를 올리세요."
