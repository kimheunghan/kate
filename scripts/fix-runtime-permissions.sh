#!/usr/bin/env bash
# rootless Podman bind mount를 컨테이너의 node(1000:1000)가 쓸 수 있게 맞춘다.
set -euo pipefail

cd "$(dirname "$0")/.."

UPLOAD_HOST_DIR="./data/uploads"
if [[ -f .env ]]; then
  configured_dir="$(sed -n 's/^UPLOAD_HOST_DIR=//p' .env | tail -n 1)"
  [[ -n "${configured_dir}" ]] && UPLOAD_HOST_DIR="${configured_dir}"
fi

if [[ "${UPLOAD_HOST_DIR}" != /* ]]; then
  UPLOAD_HOST_DIR="${PWD}/${UPLOAD_HOST_DIR#./}"
fi

mkdir -p "${UPLOAD_HOST_DIR}"

if command -v podman >/dev/null 2>&1; then
  # rootless Podman 사용자 네임스페이스의 UID/GID를 호스트 UID로 변환한다.
  podman unshare chown -R 1000:1000 "${UPLOAD_HOST_DIR}"
else
  echo "[!] podman이 없어 업로드 권한을 보정할 수 없습니다." >&2
  exit 1
fi

echo "[✔] 업로드 권한 보정 완료: ${UPLOAD_HOST_DIR} -> container 1000:1000"
