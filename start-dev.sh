#!/bin/bash
# Start ZhiPane dev stack: database (docker) + server + web.
set -m
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "[dev] starting database via docker compose..."
cd "$ROOT" || exit 1
docker compose up -d db

echo "[dev] waiting for database to become healthy..."
until docker exec zhipane-db pg_isready -U zhipane -d zhipane >/dev/null 2>&1; do
  sleep 1
done
echo "[dev] database is ready."

echo "[dev] running database migrations..."
cd "$ROOT/apps/server" || exit 1
pnpm db:migrate

echo "[dev] starting server..."
cd "$ROOT/apps/server" || exit 1
pnpm start &
SRV=$!
cd "$ROOT/apps/web" || exit 1
pnpm dev &
WEB=$!
echo "server pid=$SRV web pid=$WEB"
wait
