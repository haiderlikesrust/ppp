# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/bigint-buffer ./vendor/bigint-buffer
RUN npm ci --no-audit --no-fund

# Static frontend (Vite) built once and served by the gateway.
FROM dependencies AS web-build
COPY . .
RUN npm run build

FROM dependencies AS server-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

# API + coordinator: orders, claims, snapshots, fee routing and burns.
FROM node:22-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 API_PORT=4100
COPY --from=server-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node vendor/bigint-buffer ./vendor/bigint-buffer
# Calibration reports are written here (mounted as a volume in compose).
RUN mkdir -p /app/reports && chown node:node /app/reports
USER node
EXPOSE 4100
CMD ["node", "--import", "tsx", "server/index.ts"]

# Nginx serves the built site and proxies /api to the server.
FROM nginx:1.28-alpine AS gateway
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist /usr/share/nginx/html
EXPOSE 80
