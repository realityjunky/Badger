# syntax=docker/dockerfile:1

# Build from the repository root: docker build -f packages/server/Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY packages/hosts/package.json packages/hosts/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci
COPY packages/kernel packages/kernel
COPY packages/hosts packages/hosts
COPY packages/server packages/server
COPY packages/mcp packages/mcp
COPY packages/web packages/web
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/kernel/package.json ./packages/kernel/package.json
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/kernel/assets ./packages/kernel/assets
COPY --from=build /app/packages/hosts/package.json ./packages/hosts/package.json
COPY --from=build /app/packages/hosts/dist ./packages/hosts/dist
COPY --from=build /app/packages/mcp/package.json ./packages/mcp/package.json
COPY --from=build /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/migrations ./packages/server/migrations
COPY --from=build /app/packages/server/config ./packages/server/config
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY --from=build /app/packages/web/package.json ./packages/web/package.json

# The deploy passes the revision it built; the health endpoint reports both.
ARG BADGER_REVISION=unknown
# Leave empty when the deploy does not know: the health endpoint reports null.
ARG BADGER_CLEAN_TREE=
ENV BADGER_REVISION=${BADGER_REVISION} \
    BADGER_CLEAN_TREE=${BADGER_CLEAN_TREE}

# The default storage root and its directories, owned by the server's user. A
# deployment mounts a volume on the root or on each directory: Docker gives a
# new volume the owner of the directory it covers, and a directory missing from
# the image would leave its volume owned by root.
RUN mkdir -p /app/.badger/blob /app/.badger/workspaces /app/.badger/runs \
    && chown -R node:node /app/.badger

USER node
EXPOSE 8787
CMD ["node", "packages/server/dist/src/index.js"]
