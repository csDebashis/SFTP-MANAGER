#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$project_dir"

fail() {
  printf 'Podman deployment contract failed: %s\n' "$1" >&2
  exit 1
}

assert_file() {
  [ -f "$1" ] || fail "missing $1"
}

assert_contains() {
  file=$1
  pattern=$2
  grep -F -- "$pattern" "$file" >/dev/null || fail "$file does not contain: $pattern"
}

assert_file backend/Containerfile
assert_file frontend/Containerfile
assert_file compose.yaml
assert_file scripts/verify-build-deploy.sh

[ ! -e backend/Dockerfile ] || fail 'backend/Dockerfile must be replaced by backend/Containerfile'
[ ! -e frontend/Dockerfile ] || fail 'frontend/Dockerfile must be replaced by frontend/Containerfile'

assert_contains compose.yaml 'dockerfile: Containerfile'
assert_contains scripts/verify-build-deploy.sh 'podman build'
assert_contains scripts/verify-build-deploy.sh 'podman run'
assert_contains scripts/verify-build-deploy.sh 'podman compose config --quiet'
assert_contains scripts/verify-build-deploy.sh 'podman compose build'
assert_contains scripts/verify-build-deploy.sh 'podman compose up --detach --remove-orphans --wait'
assert_contains scripts/verify-build-deploy.sh 'PODMAN_COMPOSE_PROVIDER'

if grep -F -- 'docker compose' scripts/verify-build-deploy.sh >/dev/null; then
  fail 'release script must not invoke Docker Compose'
fi

printf '%s\n' 'Podman deployment contract passed.'
