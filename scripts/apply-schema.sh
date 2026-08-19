#!/usr/bin/env bash
# =====================================================================
#  PostgreSQL 스키마를 설치하거나 최신 버전으로 갱신합니다.
#  - wr 스키마 없음: init 스키마/기초자료 생성 후 마이그레이션 적용
#  - wr 스키마 있음: 기존 데이터는 유지하고 마이그레이션만 순서대로 적용
#
#      bash scripts/apply-schema.sh                    # .env 값 사용
#      DB_HOST=192.168.200.116 bash scripts/apply-schema.sh
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && . ./.env && set +a

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-16432}"
DB_NAME="${DB_NAME:-weekly_report}"
DB_USER="${DB_USER:-wruser}"

# 개발용 Compose의 서비스명은 호스트에서 해석되지 않으므로 노출 포트 사용
if [[ "${DB_HOST}" == "db" ]]; then
  DB_HOST="127.0.0.1"
  DB_PORT="${DB_EXPOSE_PORT:-15432}"
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
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
         -v ON_ERROR_STOP=1 -f "${file}"
  else
    # psql 이 없으면 postgres 컨테이너로 대신 실행
    echo "    (psql 미설치 → postgres 컨테이너 이용)"
    podman run --rm -i --network host \
      -e PGPASSWORD="${DB_PASSWORD}" \
      docker.io/library/postgres:16-alpine \
      psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
           -v ON_ERROR_STOP=1 < "${file}"
  fi
}

schema_exists() {
  local sql="SELECT 1 FROM information_schema.schemata WHERE schema_name='wr'"
  if command -v psql >/dev/null 2>&1; then
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -Atqc "${sql}"
  else
    podman run --rm --network host -e PGPASSWORD="${DB_PASSWORD}" \
      docker.io/library/postgres:16-alpine \
      psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -Atqc "${sql}"
  fi
}

if [[ "$(schema_exists)" != "1" ]]; then
  echo "[*] 신규 DB: 기본 스키마와 기초자료를 생성합니다."
  run_sql db/init/01_schema.sql
  run_sql db/init/02_seed.sql
else
  echo "[*] 기존 DB: 데이터는 유지하고 마이그레이션만 적용합니다."
fi

for file in db/migrations/*.sql; do
  [[ -e "${file}" ]] || continue
  run_sql "${file}"
done

echo "[✔] 스키마 설치/마이그레이션 완료"
