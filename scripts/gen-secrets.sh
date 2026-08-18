#!/usr/bin/env bash
# =====================================================================
#  .env 의 비어 있는 비밀값을 랜덤으로 채웁니다.
#      bash scripts/gen-secrets.sh
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "[+] .env 생성 (.env.example 복사)"
fi

rand_hex() { openssl rand -hex "${1:-24}" 2>/dev/null || head -c "$((${1:-24} * 2))" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# 사람이 옮겨 적기 쉬운 비밀번호 (영문 대소문자 + 숫자)
rand_pw() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "${1:-20}"; }

fill() {                 # fill KEY VALUE
  local key="$1" val="$2"
  local cur
  cur="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  if [[ -z "${cur}" ]]; then
    # BSD/GNU sed 호환을 위해 임시파일 사용
    awk -v k="${key}" -v v="${val}" \
      'BEGIN{FS=OFS="="} $1==k && NF>=1 {print k "=" v; next} {print}' .env > .env.tmp
    mv .env.tmp .env
    echo "  ${key} = ${val}"
  else
    echo "  ${key} = (이미 설정됨, 유지)"
  fi
}

echo "[*] 비밀값 생성"
fill SESSION_SECRET "$(rand_hex 32)"
fill DB_PASSWORD    "$(rand_pw 24)"
fill ADMIN_PASSWORD "$(rand_pw 16)"

chmod 600 .env
echo
echo "[✔] 완료. .env 파일을 확인하세요. (권한 600)"
echo "    관리자 초기 계정:  $(grep -E '^ADMIN_USERNAME=' .env | cut -d= -f2)  /  $(grep -E '^ADMIN_PASSWORD=' .env | cut -d= -f2)"
echo "    → 최초 로그인 후 반드시 비밀번호를 변경하세요."
