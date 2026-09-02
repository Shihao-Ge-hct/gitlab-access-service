ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN corepack enable \
  && corepack prepare pnpm@10.34.5 --activate \
  && pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=10001:10001 /app/dist ./dist

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["node", "dist/server.js"]
