#!/bin/sh
for path in /healthz /healthz/overleaf /healthz/ollama; do
    if ! wget -q -T 5 -O /dev/null "http://127.0.0.1${path}"; then
        echo "unhealthy: ${path}" >&2
        exit 1
    fi
done
