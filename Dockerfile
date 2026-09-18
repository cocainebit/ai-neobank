# The API and the worker ship as one image; Fly runs them as separate processes.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
# The console is deployed separately, so its dependencies are not installed here.
RUN pnpm install --frozen-lockfile --filter "@ai-neobank/api..." --filter "@ai-neobank/worker..." --filter "@ai-neobank/database..."
RUN pnpm turbo run build --filter "@ai-neobank/api" --filter "@ai-neobank/worker" --filter "@ai-neobank/database"

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
