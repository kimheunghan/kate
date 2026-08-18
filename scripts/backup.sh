#!/usr/bin/env bash
# =====================================================================
#  DB + 증적자료 백업
#      bash scripts/backup.sh [출력디렉터리]
#  결과: <출력디렉터리>/wr-YYYYmmdd-HHMMSS.{sql.gz,uploads.tar.gz}
#
#  cron 예) 매일 새벽 2시
#      0 2 * * * cd /opt/weekly-report && bash scripts/backup.sh /backup >> /var/log/wr-backup.log 2>&1
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && . ./.env && set +a

OUT="${1:-./backup}"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${OUT}"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-weekly_report}"
DB_USER="${DB_USER:-wruser}"
export PGPASSWORD="${DB_PASSWORD:-}"

# compose 안에서 DB_HOST=db 인 경우 호스트에서는 노출 포트로 접근
if [[ "${DB_HOST}" == "db" ]]; then
  DB_HOST="127.0.0.1"
  DB_PORT="${DB_EXPOSE_PORT:-15432}"
fi

echo "[*] DB 덤프: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists
else
  podman run --rm --network host -e PGPASSWORD="${PGPASSWORD}" \
    docker.io/library/postgres:16-alpine \
    pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists
fi | gzip > "${OUT}/wr-${TS}.sql.gz"

echo "[*] 증적자료 백업"
UPLOADS="${UPLOAD_HOST_DIR:-./data/uploads}"
if [[ -d "${UPLOADS}" ]]; then
  tar czf "${OUT}/wr-${TS}.uploads.tar.gz" -C "$(dirname "${UPLOADS}")" "$(basename "${UPLOADS}")"
elif podman volume exists wr-uploads 2>/dev/null; then
  # 명명된 볼륨을 쓰는 개발 구성
  podman run --rm -v wr-uploads:/data:ro -v "$(realpath "${OUT}")":/out:z \
    docker.io/library/alpine:3 \
    tar czf "/out/wr-${TS}.uploads.tar.gz" -C /data .
else
  echo "    (업로드 디렉터리를 찾지 못해 건너뜁니다)"
fi

echo "[*] 30일 지난 백업 정리"
find "${OUT}" -name 'wr-*.gz' -type f -mtime +30 -delete 2>/dev/null || true

echo "[✔] 완료"
ls -lh "${OUT}"/wr-"${TS}"* 2>/dev/null || true
