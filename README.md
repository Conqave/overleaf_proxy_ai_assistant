# overleaf_proxy_ai_assistant

Nginx proxy for Overleaf CE with the AI assistant injected into the editor UI.

## Files
- `nginx.conf` - proxy configuration for Overleaf CE and Ollama
- `ola-helper.js` - assistant helper script
- `overleaf-ai-assistant.js` - runtime-served assistant script
- `docker-compose.yml` - local container setup for the proxy

## Run with Docker Compose
```bash
docker compose up -d
```

The container serves:
- Overleaf CE through the proxy
- `/ollama/main/` as the Ollama bridge
- `/overleaf-ai-assistant.js` as the assistant script
