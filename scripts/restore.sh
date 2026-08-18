#!/usr/bin/env bash
# =====================================================================
#  백업 복원
#      bash scripts/restore.sh backup/wr-20260818-020000.sql.gz [uploads.tar.gz]
#  ※ 기존 데이터를 덮어씁니다. 실행 전 반드시 확인하세요.
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && . ./.env && set +a

SQL_GZ="${1:?복원할 .sql.gz 파일을 지정하세요}"
UPLOADS_GZ="${2:-}"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-weekly_report}"
DB_USER="${DB_USER:-wruser}"
export PGPASSWORD="${DB_PASSWORD:-}"

if [[ "${DB_HOST}" == "db" ]]; then
  DB_HOST="127.0.0.1"; DB_PORT="${DB_EXPOSE_PORT:-15432}"
fi

echo "⚠  ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} 의 현재 데이터가 삭제되고"
echo "   ${SQL_GZ} 내용으로 대체됩니다."
read -rp "계속하려면 'yes' 를 입력하세요: " ans
[[ "${ans}" == "yes" ]] || { echo "취소됨"; exit 1; }

echo "[*] DB 복원"
if command -v psql >/dev/null 2>&1; then
  gunzip -c "${SQL_GZ}" | psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1
else
  gunzip -c "${SQL_GZ}" | podman run --rm -i --network host -e PGPASSWORD="${PGPASSWORD}" \
    docker.io/library/postgres:16-alpine \
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1
fi

if [[ -n "${UPLOADS_GZ}" ]]; then
  echo "[*] 증적자료 복원"
  UPLOADS="${UPLOAD_HOST_DIR:-./data/uploads}"
  mkdir -p "${UPLOADS}"
  tar xzf "${UPLOADS_GZ}" -C "$(dirname "${UPLOADS}")"
fi

echo "[✔] 복원 완료. 애플리케이션을 재기동하세요:  bash scripts/deploy.sh restart"
