#!/usr/bin/env bash
# =====================================================================
#  db/migrations/*.sql 을 순서대로 적용합니다. (이미 적용된 것은 no-op)
#      bash scripts/migrate.sh
#      DB_HOST=192.168.200.116 bash scripts/migrate.sh
#
#  ※ 신규 설치는 db/init/01_schema.sql 에 모두 반영되어 있으므로 불필요합니다.
#     이미 운영 중인 DB 를 최신 스키마로 올릴 때 사용하세요.
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && . ./.env && set +a

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-weekly_report}"
DB_USER="${DB_USER:-wruser}"

# compose 내부 호스트명이면 호스트에서는 노출 포트로 접근
if [[ "${DB_HOST}" == "db" ]]; then
  DB_HOST="127.0.0.1"; DB_PORT="${DB_EXPOSE_PORT:-15432}"
fi

if [[ -z "${DB_PASSWORD:-}" ]]; then
  read -rsp "DB 비밀번호: " DB_PASSWORD; echo
fi
export PGPASSWORD="${DB_PASSWORD}"

echo "[*] 대상: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

run_sql() {
  local file="$1"
  echo "[*] 적용: ${file}"
  if command -v psql >/dev/null 2>&1; then
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q -f "${file}"
  else
    podman run --rm -i --network host -e PGPASSWORD="${DB_PASSWORD}" \
      docker.io/library/postgres:16-alpine \
      psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q < "${file}"
  fi
}

shopt -s nullglob
files=(db/migrations/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "[!] db/migrations 에 적용할 파일이 없습니다."
  exit 0
fi

for f in "${files[@]}"; do run_sql "$f"; done

echo "[✔] 마이그레이션 완료"
