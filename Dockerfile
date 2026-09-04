FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM nginx:1.29-alpine
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx \
    NGINX_ENVSUBST_FILTER='^(OVERLEAF_|OLLAMA_|ASSISTANT_)'
COPY deploy/nginx.conf.template /etc/nginx/templates/nginx.conf.template
COPY --chmod=755 deploy/10-assistant-config.envsh /docker-entrypoint.d/10-assistant-config.envsh
COPY --chmod=755 deploy/healthcheck.sh /usr/local/bin/healthcheck
COPY --from=build /app/dist/overleaf-ai-assistant.js /usr/share/nginx/html/overleaf-ai-assistant.js
HEALTHCHECK --interval=30s --timeout=20s --start-period=10s --retries=3 CMD ["healthcheck"]
