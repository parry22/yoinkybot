# Yoinky backend — multi-stage production image (compiled dist, not tsx).
# Single-process monolith: Fastify + grammY bot + pg-boss jobs.

FROM node:20-slim AS deps
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
RUN pnpm install --frozen-lockfile --filter @yoink/backend...

FROM deps AS build
COPY packages/backend packages/backend
COPY docs docs
RUN pnpm --filter @yoink/backend build

FROM node:20-slim AS runner
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
# Production deps only — no tsx / vitest in the runtime image.
RUN pnpm install --frozen-lockfile --filter @yoink/backend... --prod

COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/docs docs

WORKDIR /app/packages/backend
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Graceful shutdown: index.ts handles SIGTERM/SIGINT via stopBoss + analytics flush.
CMD ["node", "dist/index.js"]
