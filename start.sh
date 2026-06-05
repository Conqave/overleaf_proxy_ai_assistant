#!/bin/sh
set -eu

cd "$(dirname "$0")"

DOCKER_BIN="${DOCKER_BIN:-/usr/bin/docker}"

if "$DOCKER_BIN" compose version >/dev/null 2>&1; then
  "$DOCKER_BIN" compose up -d
else
  "$DOCKER_BIN" rm -f overleaf-ai-proxy >/dev/null 2>&1 || true
  "$DOCKER_BIN" run -d \
    --name overleaf-ai-proxy \
    --restart unless-stopped \
    -p 80:80 \
    -v "$PWD/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$PWD/overleaf-ai-assistant.js:/usr/share/nginx/html/overleaf-ai-assistant.js:ro" \
    nginx:1.29-alpine
fi

"$DOCKER_BIN" ps --filter name=overleaf-ai-proxy
