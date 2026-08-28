# syntax=docker/dockerfile:1

# ---- stage: web-build -------------------------------------------------
# Builds the React/Vite frontend into static assets (web/dist).
FROM node:22-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- stage: runtime -----------------------------------------------------
# Fastify server + built web assets. Single container, no reverse proxy
# needed — Fastify serves both the API and the SPA (see server/src/app.js).
FROM node:22-slim AS runtime
WORKDIR /app

# argon2 and better-sqlite3 ship prebuilt native binaries for linux/x64 and
# linux/arm64 on Node 22 (both via node-gyp-build / prebuild-install), so a
# plain `npm ci --omit=dev` succeeds without a compiler on either arch this
# image targets (the macmini-hub host is arm64). python3/make/g++ are
# installed anyway as a fallback for the rare case a prebuild is missing for
# the exact Node ABI/libc (this base image is glibc, not musl) — installed
# and removed in the same layer so the final image doesn't carry a toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/src ./server/src
COPY --from=web-build /app/web/dist ./web/dist

ENV NODE_ENV=production \
    PORT=8082 \
    DATA_DIR=/data

EXPOSE 8082

CMD ["node", "server/src/server.js"]
