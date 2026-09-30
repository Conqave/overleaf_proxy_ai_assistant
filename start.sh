#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Missing .env - copy .env.example to .env and set the upstreams and model." >&2
  exit 1
fi

docker compose up -d --build
docker compose ps
