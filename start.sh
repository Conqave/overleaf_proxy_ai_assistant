#!/bin/sh
set -eu

cd "$(dirname "$0")"

DOCKER_BIN="${DOCKER_BIN:-docker}"

if [ ! -f .env ]; then
  echo "Missing .env - copy .env.example to .env and set the upstreams and model." >&2
  exit 1
fi

"$DOCKER_BIN" compose up -d --build
"$DOCKER_BIN" ps --filter name=overleaf-ai-proxy
