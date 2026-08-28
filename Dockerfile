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

COPY server/package.json server/package-lock.json ./

# argon2 and better-sqlite3 ship prebuilt native binaries for linux/x64 and
# linux/arm64 on Node 22 (both via node-gyp-build / prebuild-install), so a
# plain `npm ci --omit=dev` succeeds without a compiler on either arch this
# image targets (the macmini-hub host is arm64). python3/make/g++ are
# installed anyway as a fallback for the rare case a prebuild is missing for
# the exact Node ABI/libc (this base image is glibc, not musl).
#
# Install, use for npm ci, and purge again — all inside this ONE RUN layer,
# so the toolchain never lands in any image layer to begin with. Splitting
# the purge into its own RUN (as a previous version of this file did,
# incorrectly claiming it kept the toolchain out) doesn't work: a Docker
# image is the union of every layer's file additions, so a later layer's
# `apt-get remove` only marks the files deleted in the *final* filesystem
# view — the earlier layer that added them is still part of the image and
# still counted in its size/attack surface.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server/src ./server/src
COPY --from=web-build /app/web/dist ./web/dist

ENV NODE_ENV=production \
    PORT=8082 \
    DATA_DIR=/data

# The server writes its sqlite db + uploaded media under DATA_DIR (default
# /data — see server/src/db.js) at runtime, as the unprivileged `node` user
# set below, so that path has to be writable by it. This covers a named
# Docker volume (Docker creates it empty and owned by `node` automatically
# on first mount). A host bind mount instead keeps the host directory's own
# ownership/permissions — for that case, either chown the host directory to
# match the `node` user/group inside the image, or run the container with
# `--user` overridden to a UID that already owns it (see README).
RUN mkdir -p /data && chown -R node:node /app /data

EXPOSE 8082

# Don't run the server as root — the `node` base image ships a non-root
# `node` user for exactly this. Must come after both the apt install/purge
# above (root is needed for that) and the chown above.
USER node

CMD ["node", "server/src/server.js"]
