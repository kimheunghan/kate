#!/usr/bin/env bash
# =====================================================================
#  이관 패키지 생성 / 배포
#
#    bash scripts/deploy.sh package        # 이미지 + 소스를 tar 로 묶기 (폐쇄망 이관용)
#    bash scripts/deploy.sh build          # APP 이미지만 빌드
#    bash scripts/deploy.sh up             # 현재 호스트에 운영 구성으로 기동
#    bash scripts/deploy.sh down           # 중지
#    bash scripts/deploy.sh logs           # 로그
#    bash scripts/deploy.sh restart        # 재기동
#    bash scripts/deploy.sh status         # 상태 확인
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE="localhost/weekly-report:1.0"
COMPOSE_FILE="docker-compose.prod.yml"

# 앱이 HTTP/HTTPS 중 무엇으로 떴는지 확인하고 그 스킴을 출력한다.
# (.env 에 SSL_CERT_FILE 이 있으면 HTTPS. 자체 서명이므로 -k 로 검증을 건너뛴다)
health_scheme() {
  local port="$1" host_ip="${2:-}" h
  for h in 127.0.0.1 ${host_ip}; do
    curl -fsSk "https://${h}:${port}/api/health" >/dev/null 2>&1 && { echo https; return 0; }
    curl -fsS  "http://${h}:${port}/api/health"  >/dev/null 2>&1 && { echo http;  return 0; }
  done
  return 1
}

# podman-compose / docker-compose 중 있는 것을 사용
if command -v podman-compose >/dev/null 2>&1; then
  COMPOSE="podman-compose"
elif podman compose version >/dev/null 2>&1; then
  COMPOSE="podman compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  COMPOSE=""
fi

need_compose() {
  [[ -n "${COMPOSE}" ]] || { echo "[!] podman-compose 가 없습니다. 'pip3 install podman-compose' 로 설치하세요."; exit 1; }
}

case "${1:-}" in

  build)
    echo "[*] APP 이미지 빌드: ${IMAGE}"
    podman build -t "${IMAGE}" -f Containerfile .
    echo "[✔] 이미지 빌드 완료: ${IMAGE}"
    ;;

  package)
    echo "[*] 이미지 빌드: ${IMAGE}"
    podman build -t "${IMAGE}" -f Containerfile .

    OUT="dist"
    mkdir -p "${OUT}"
    TS="$(date +%Y%m%d)"

    echo "[*] 이미지 저장 → ${OUT}/weekly-report-${TS}.tar"
    podman save -o "${OUT}/weekly-report-${TS}.tar" "${IMAGE}"

    echo "[*] postgres 이미지도 함께 저장 (DB 서버용)"
    podman pull docker.io/library/postgres:16-alpine
    podman save -o "${OUT}/postgres-16-alpine.tar" docker.io/library/postgres:16-alpine

    echo "[*] 배포 파일 묶기"
    tar czf "${OUT}/weekly-report-deploy-${TS}.tar.gz" \
      --exclude='./dist' --exclude='./node_modules' --exclude='./.git' \
      --exclude='./data' --exclude='./.env' --exclude='./backup' \
      ./db ./server ./public ./scripts ./Containerfile \
      ./docker-compose.yml ./docker-compose.prod.yml ./docker-compose.db.yml \
      ./.env.example ./README.md

    echo
    echo "[✔] 이관 패키지 생성 완료"
    ls -lh "${OUT}"
    cat <<EOF

  ── 이관 절차 ────────────────────────────────────────────────
  1) DB 서버 (192.168.200.116)
     scp dist/postgres-16-alpine.tar dist/weekly-report-deploy-${TS}.tar.gz  user@192.168.200.116:~/
     ssh user@192.168.200.116
       podman load -i postgres-16-alpine.tar
       mkdir -p ~/weekly-report && tar xzf weekly-report-deploy-${TS}.tar.gz -C ~/weekly-report
       cd ~/weekly-report && cp .env.example .env && bash scripts/gen-secrets.sh
       podman-compose -f docker-compose.db.yml up -d
       sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=192.168.200.115/32 port port=5432 protocol=tcp accept'
       sudo firewall-cmd --reload

  2) APP 서버 (192.168.200.115)
     scp dist/weekly-report-${TS}.tar dist/weekly-report-deploy-${TS}.tar.gz  user@192.168.200.115:~/
     ssh user@192.168.200.115
       podman load -i weekly-report-${TS}.tar
       mkdir -p ~/weekly-report && tar xzf weekly-report-deploy-${TS}.tar.gz -C ~/weekly-report
       cd ~/weekly-report && cp .env.example .env
       # .env 편집: DB_HOST=192.168.200.116, DB_PASSWORD=(DB 서버와 동일), SESSION_SECRET
       #            APP_PORT=16000   ← 개방 포트 범위 16000~16999 안에서 지정
       bash scripts/deploy.sh up

  3) 접속 확인
     내부: http://192.168.200.115:\$APP_PORT
     외부: http://183.101.26.137:\$APP_PORT
  ─────────────────────────────────────────────────────────────
EOF
    ;;

  up)
    need_compose
    [[ -f .env ]] || { echo "[!] .env 가 없습니다. cp .env.example .env 후 값을 채우세요."; exit 1; }
    # GCP에서 scp/tar로 가져온 파일은 호스트 소유자로 바뀔 수 있으므로
    # 컨테이너 node 사용자가 증적자료를 생성/삭제할 수 있게 항상 보정한다.
    bash scripts/fix-runtime-permissions.sh
    # 폐쇄망에서는 package로 가져와 podman load 한 이미지를 그대로 사용한다.
    # 소스로 새 이미지를 만들려면 먼저: bash scripts/deploy.sh build
    ${COMPOSE} -f "${COMPOSE_FILE}" up -d
    echo
    echo "[*] 기동 확인 (최대 60초 대기)"
    PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2 || echo 16000)"
    # 운영에서는 특정 IP 에만 포트를 열어 두어 127.0.0.1 로는 닿지 않는다
    HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    for i in $(seq 1 30); do
      if SCHEME="$(health_scheme "${PORT}" "${HOST_IP}")"; then
        echo "[✔] 정상 기동 → ${SCHEME}://${HOST_IP:-127.0.0.1}:${PORT}"
        exit 0
      fi
      sleep 2
    done
    echo "[!] 기동 확인 실패. 로그를 확인하세요: bash scripts/deploy.sh logs"
    exit 1
    ;;

  down)    need_compose; ${COMPOSE} -f "${COMPOSE_FILE}" down ;;
  restart)
    need_compose
    bash scripts/fix-runtime-permissions.sh
    ${COMPOSE} -f "${COMPOSE_FILE}" restart
    ;;
  logs)    podman logs -f --tail 200 wr-app ;;
  status)
    podman ps --filter name=wr- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    PORT="$(grep -E '^APP_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 16000)"
    echo
    if   curl -fsSk "https://127.0.0.1:${PORT}/api/health"; then echo
    elif curl -fsS  "http://127.0.0.1:${PORT}/api/health";  then echo
    else echo "[!] health 응답 없음"
    fi
    ;;

  *)
    sed -n '2,14p' "$0"
    exit 1
    ;;
esac
