#!/usr/bin/env bash
# =====================================================================
#  자체 서명 인증서 생성 (HTTPS 용)
#      bash scripts/gen-cert.sh aips.iptime.org
#      bash scripts/gen-cert.sh 192.168.200.115 183.101.26.137
#
#  HTTP 로 서비스하면 Chrome 이 파일 다운로드를 '안전하지 않음'으로 차단한다.
#  도메인이 없어 공인 인증서를 받을 수 없는 환경에서는 자체 서명 인증서를 쓴다.
#  (브라우저가 처음 한 번 경고를 띄우며, [고급] → [계속 진행] 하면 이후로는 뜨지 않는다)
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -eq 0 ]]; then
  echo "사용법: bash scripts/gen-cert.sh <서버IP 또는 도메인> [추가 IP/도메인 ...]"
  exit 1
fi

OUT=certs
mkdir -p "${OUT}"

# 이전 인증서는 컨테이너용으로 소유자가 바뀌어 있을 수 있어(fix-runtime-permissions.sh)
# 덮어쓰기가 막힌다. 먼저 지우고 새로 만든다.
rm -f "${OUT}/server.crt" "${OUT}/server.key"

# 접속에 쓰이는 모든 주소를 SAN 에 넣어야 브라우저가 인정한다
SAN="DNS:localhost,IP:127.0.0.1"
for h in "$@"; do
  if [[ "$h" =~ ^[0-9.]+$ ]]; then SAN="${SAN},IP:${h}"; else SAN="${SAN},DNS:${h}"; fi
done

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "${OUT}/server.key" -out "${OUT}/server.crt" \
  -subj "/C=KR/O=Weekly Report System/CN=$1" \
  -addext "subjectAltName=${SAN}" 2>/dev/null

chmod 600 "${OUT}/server.key"

echo "[✔] 인증서 생성 완료 (유효기간 10년)"
echo "    인증서 : $(pwd)/${OUT}/server.crt"
echo "    개인키 : $(pwd)/${OUT}/server.key"
echo "    대상   : ${SAN}"
echo
echo "  .env 에 아래 두 줄을 넣고 재기동하세요."
echo "    SSL_CERT_FILE=/app/certs/server.crt"
echo "    SSL_KEY_FILE=/app/certs/server.key"
echo "    COOKIE_SECURE=true"
