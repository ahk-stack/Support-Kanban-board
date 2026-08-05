# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Support Kanban MCP server — preprod image
# Pure-JS dependencies only (no native addons, no Prisma, no DB) - single
# stage is enough. Build context is the mcp-server/ directory:
#   docker build -f docker/mcp-server.Dockerfile mcp-server/
# Built/pushed by CI as: qtk8s.azurecr.io/support-kanban-mcp_code:preprod
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production \
    PORT=3100 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# tini = correct PID 1 (signal forwarding + zombie reaping). Dedicated
# unprivileged user/group, matching the main support-kanban image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin nodejs

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY index.js ./

RUN chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3100

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
