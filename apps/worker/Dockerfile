FROM node:lts-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN corepack enable

FROM base AS pruner
LABEL stage=intermediate
WORKDIR /app
COPY package.json ./
COPY . .
RUN pnpm dlx turbo prune --scope=worker --docker

FROM base AS builder
LABEL stage=intermediate
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm run worker:build

FROM base AS installer
LABEL stage=intermediate
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=builder /app/packages/core/dist /app/packages/core/dist
COPY --from=builder /app/packages/persistence/dist /app/packages/persistence/dist
COPY --from=builder /app/packages/sync-engine/dist /app/packages/sync-engine/dist
COPY --from=builder /app/apps/worker/dist /app/apps/worker/dist

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 fastify
USER fastify
COPY --from=installer --chown=fastify:nodejs /app .
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=10 CMD node apps/worker/dist/healthcheck.js
CMD ["node", "apps/worker/dist/index.js"]
