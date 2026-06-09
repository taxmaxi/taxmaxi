FROM node:26-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN npm install -g pnpm@11.5.2

FROM base AS pruner
LABEL stage=intermediate
WORKDIR /app
COPY package.json ./
COPY . .
RUN pnpm dlx turbo prune --scope=server --docker

FROM base AS builder
LABEL stage=intermediate
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm run build --filter=server...

FROM base AS installer
LABEL stage=intermediate
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=builder /app/packages/core/dist /app/packages/core/dist
COPY --from=builder /app/packages/persistence/dist /app/packages/persistence/dist
COPY --from=builder /app/packages/sync-engine/dist /app/packages/sync-engine/dist
COPY --from=builder /app/packages/rest-api/dist /app/packages/rest-api/dist
COPY --from=builder /app/apps/server/dist /app/apps/server/dist

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 fastify
USER fastify
COPY --from=installer --chown=fastify:nodejs /app .
EXPOSE 4000
CMD ["node", "apps/server/dist/index.js"]
