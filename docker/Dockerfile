# syntax=docker/dockerfile:1

# Debian rather than Alpine on purpose: better-sqlite3 ships prebuilt bindings
# for glibc on both amd64 and arm64, so the image builds on an Intel NAS and on
# an ARM one without a compiler toolchain. Alpine's musl has no prebuilds and
# would force a node-gyp build on every architecture.
ARG NODE_VERSION=22-bookworm-slim

# ---- build -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Manifests first: this layer only changes when dependencies do, so day-to-day
# source edits reuse the cached install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @obsidiansync/server... --filter .

COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN pnpm --filter @obsidiansync/protocol build && pnpm --filter @obsidiansync/server build

# Collapse the workspace into a self-contained tree with production deps only.
RUN pnpm deploy --filter=@obsidiansync/server --prod --legacy /app \
    && rm -rf /app/src /app/test /app/tsconfig.json

# ---- runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8080

WORKDIR /app
COPY --from=build /app ./

# The vault is somebody's notes: run as an unprivileged user, and own /data so
# the server can write without needing root.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

VOLUME ["/data"]
EXPOSE 8080

# Uses the unauthenticated health route, so the check needs no token baked in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
