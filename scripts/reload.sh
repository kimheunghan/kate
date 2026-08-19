#!/usr/bin/env bash
# =====================================================================
#  앱만 재배포 (DB 는 건드리지 않음)
#      bash scripts/reload.sh
#  podman-compose down 은 DB 까지 내려 20초 이상 끊기므로 개발 중에는 이 스크립트를 쓴다.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

podman build -q -t localhost/weekly-report:1.0 -f Containerfile . >/dev/null
podman-compose up -d --no-deps app >/dev/null 2>&1 || podman-compose up -d >/dev/null 2>&1

PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2 || echo 16080)"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "[✔] 앱 재배포 완료 (${i}초)"; exit 0
  fi
  sleep 1
done
echo "[!] 기동 확인 실패 — podman logs wr-app 확인"; exit 1
