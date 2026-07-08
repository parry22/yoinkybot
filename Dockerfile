# Yoinky backend — single-process monolith (Fastify + grammY bot + pg-boss jobs).
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
RUN pnpm install --frozen-lockfile

COPY packages/backend packages/backend
COPY docs docs

# Config comes from real environment variables (never bake a .env into the image).
ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@yoink/backend", "exec", "tsx", "src/index.ts"]
