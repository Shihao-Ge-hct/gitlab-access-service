FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 app \
  && useradd --system --uid 10001 --gid 10001 --no-create-home app

COPY --from=build --chown=10001:10001 /app/dist ./dist

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "dist/server.js"]
