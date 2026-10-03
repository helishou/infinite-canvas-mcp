# Build all consumers from the same npm workspace lockfile.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY canvas-agent/package.json canvas-agent/package.json
COPY web/package.json web/package.json
COPY plugins/canvas/sdk plugins/canvas/sdk
COPY scripts/patch-rc-portal.mjs scripts/patch-rc-portal.mjs
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN node scripts/build-official-plugins.mjs \
    && npm run build --workspace canvas-agent \
    && npm run build --workspace backend \
    && VITE_PLUGIN_REGISTRY_URL=/plugins/official-plugins.json npm run build --workspace web

FROM build AS production-deps
RUN npm prune --omit=dev && mkdir -p backend/node_modules canvas-agent/node_modules

# Backend has no GPU/model dependency. ComfyUI is a separately configured service.
FROM node:22-bookworm-slim AS backend
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pil git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/backend/node_modules ./backend/node_modules
COPY --from=production-deps /app/canvas-agent/node_modules ./canvas-agent/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/workflows ./backend/workflows
COPY --from=build /app/backend/workers ./backend/workers
COPY --from=build /app/canvas-agent/package.json ./canvas-agent/package.json
COPY --from=build /app/canvas-agent/dist ./canvas-agent/dist
COPY --from=build /app/canvas-agent/agent-instructions.md ./canvas-agent/agent-instructions.md
COPY --from=build /app/scripts/acheng-engine.mjs ./scripts/acheng-engine.mjs
COPY --from=build /app/scripts/acheng ./scripts/acheng
ENV NODE_ENV=production \
    PORT=17370 \
    INFINITE_CANVAS_LISTEN_HOST=0.0.0.0 \
    INFINITE_CANVAS_DATA_DIR=/data/backend \
    INFINITE_CANVAS_AGENT_CONFIG_DIR=/data/agent \
    CODEX_HOME=/data/codex \
    ACHENG_PYTHON=python3
RUN mkdir -p /data/backend /data/agent /data/codex && chown -R node:node /data
USER node
EXPOSE 17370
CMD ["node", "backend/dist/index.js"]

# Optional sidebar Codex chat image; authentication belongs to the deployer.
FROM backend AS backend-codex
USER root
RUN npm install -g @openai/codex@0.160.0
USER node

FROM nginx:1.27-alpine AS frontend
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh
EXPOSE 3000

# Web gateway selected by Compose.
FROM frontend AS app
COPY deploy/nginx.full-stack.conf /etc/nginx/conf.d/default.conf
RUN touch /etc/nginx/canvas-full-stack

# Keep docker build / Render static hosting compatible; Compose selects app explicitly.
FROM frontend AS standalone
