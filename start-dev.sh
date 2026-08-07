#!/bin/bash
# Start ZhiPane dev servers (server + web) in foreground.
set -m
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/apps/server" || exit 1
pnpm start &
SRV=$!
cd "$ROOT/apps/web" || exit 1
pnpm dev &
WEB=$!
echo "server pid=$SRV web pid=$WEB"
wait
