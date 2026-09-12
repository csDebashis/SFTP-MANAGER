#!/bin/sh

set -eu

usage() {
  printf '%s\n' \
    "Usage: $0 [--verify-only]" \
    "" \
    "Runs backend and frontend tests in isolated Docker targets, builds the" \
    "production images, validates Compose, and deploys the stack." \
    "Use --verify-only to stop after tests and production image builds."
}

mode=deploy
if [ "${1:-}" = "--verify-only" ]; then
  mode=verify
  shift
elif [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -ne 0 ]; then
  usage >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
application_log_dir="$project_dir/logs"
cd "$project_dir"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

require_file() {
  if [ ! -f "$1" ]; then
    printf 'Required file not found: %s\n' "$1" >&2
    printf '%s\n' 'Implement the application scaffold described in SPEC.md before running this script.' >&2
    exit 1
  fi
}

require_command docker
docker compose version >/dev/null

require_file backend/pyproject.toml
require_file backend/app/main.py
require_file backend/alembic.ini
require_file frontend/package.json
require_file frontend/package-lock.json

printf '%s\n' 'Building and running backend tests...'
docker build --target test --tag sftp-manager-backend-test:local ./backend
docker run --rm sftp-manager-backend-test:local

printf '%s\n' 'Building and running frontend tests...'
docker build --target test --tag sftp-manager-frontend-test:local ./frontend
docker run --rm sftp-manager-frontend-test:local

printf '%s\n' 'Validating the Docker Compose model...'
BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-admin@example.invalid}" docker compose config --quiet

printf '%s\n' 'Building production images...'
BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-admin@example.invalid}" docker compose build

if [ "$mode" = verify ]; then
  printf '%s\n' 'Verification and production image builds completed successfully.'
  exit 0
fi

if [ -z "${BOOTSTRAP_ADMIN_EMAIL:-}" ]; then
  printf '%s\n' 'BOOTSTRAP_ADMIN_EMAIL must be set for deployment.' >&2
  exit 1
fi

for secret_file in \
  deploy/secrets/session_signing_key \
  deploy/secrets/credential_encryption_key \
  deploy/secrets/bootstrap_admin_password
do
  require_file "$secret_file"
  if [ ! -s "$secret_file" ]; then
    printf 'Secret file is empty: %s\n' "$secret_file" >&2
    exit 1
  fi
done

mkdir -p "$application_log_dir"
if [ ! -w "$application_log_dir" ]; then
  printf 'Application log directory is not writable: %s\n' "$application_log_dir" >&2
  exit 1
fi

printf '%s\n' 'Deploying the stack and waiting for healthy services...'
docker compose up --detach --remove-orphans --wait
docker compose ps

printf '%s\n' 'Verifying the backend filesystem log...'
docker compose exec -T backend python -c \
  "from pathlib import Path; path = Path('/var/log/sftp-manager/application.log'); assert path.is_file() and path.stat().st_size > 0, f'Missing or empty application log: {path}'"
if [ ! -s "$application_log_dir/application.log" ]; then
  printf 'Missing or empty host application log: %s\n' "$application_log_dir/application.log" >&2
  exit 1
fi

printf 'SFTP Manager is available at %s\n' "${PUBLIC_URL:-http://localhost:${PORT:-3000}}"
