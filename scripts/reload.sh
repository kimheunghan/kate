#!/usr/bin/env bash
# =====================================================================
#  앱만 재배포 (DB 는 그대로 유지)
#      bash scripts/reload.sh
#
#  podman-compose up 은 compose 정의가 그대로면 이미지가 새로 빌드돼도
#  컨테이너를 교체하지 않는다. 그래서 앱 컨테이너를 명시적으로 제거 후 다시 띄운다.
#  (DB 컨테이너는 건드리지 않으므로 접속·데이터에 영향 없음)
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2 || echo 16000)"

# 어느 compose 정의로 띄울지 고른다.
#   .env 의 COMPOSE_FILE 이 있으면 그대로 쓰고,
#   없으면 DB 위치로 판단한다. DB_HOST=db 는 개발(한 대에 DB 까지),
#   그 밖은 운영(DB 가 다른 서버).
#  ※ 예전에는 -f 를 주지 않아 운영에서도 개발용 정의로 띄우려다
#    앱 컨테이너를 지운 뒤 기동에 실패해 서비스가 내려갔다.
COMPOSE_FILE="$(grep -E '^COMPOSE_FILE=' .env 2>/dev/null | cut -d= -f2- || true)"
if [[ -z "${COMPOSE_FILE}" ]]; then
  DB_HOST_VAL="$(grep -E '^DB_HOST=' .env 2>/dev/null | cut -d= -f2- || true)"
  if [[ "${DB_HOST_VAL}" == "db" || -z "${DB_HOST_VAL}" ]]; then
    COMPOSE_FILE="docker-compose.yml"
  else
    COMPOSE_FILE="docker-compose.prod.yml"
  fi
fi
[[ -f "${COMPOSE_FILE}" ]] || { echo "[!] compose 파일이 없습니다: ${COMPOSE_FILE}"; exit 1; }

# 소스/첨부파일 동기화 과정에서 달라질 수 있는 rootless UID를 먼저 보정한다.
bash scripts/fix-runtime-permissions.sh

# 헬스체크 주소. 운영에서는 특정 IP 에만 포트를 열어 두어
# 127.0.0.1 로는 닿지 않는다. 두 곳을 모두 시도한다.
health_ok() {
  curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && return 0
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "${ip}" ]] && curl -fsS "http://${ip}:${PORT}/api/health" >/dev/null 2>&1
}

echo "[*] 이미지 빌드"
podman build -q -t localhost/weekly-report:1.0 -f Containerfile . >/dev/null

echo "[*] 앱 컨테이너 교체 (${COMPOSE_FILE})"
podman rm -f wr-app >/dev/null 2>&1 || true

# 기동 실패를 감추지 않는다. 실패하면 그 자리에서 이유가 보여야 한다.
if ! podman-compose -f "${COMPOSE_FILE}" up -d --no-deps app; then
  echo "[!] app 만 띄우기 실패 — 전체 기동으로 다시 시도합니다"
  podman-compose -f "${COMPOSE_FILE}" up -d
fi

for i in $(seq 1 40); do
  if health_ok; then
    echo "[✔] 앱 재배포 완료 (${i}초)"
    exit 0
  fi
  sleep 1
done
echo "[!] 기동 확인 실패 — podman logs wr-app 확인"
exit 1
