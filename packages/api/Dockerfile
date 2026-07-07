# Multi-stage container for @clearview/api within the pnpm monorepo.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
# Install workspace deps for the api and its internal deps (shared).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN pnpm install --frozen-lockfile --filter @clearview/api...
# Build shared → api, then produce a self-contained deploy bundle.
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN pnpm --filter @clearview/shared build \
  && pnpm --filter @clearview/api build \
  && pnpm --filter @clearview/api deploy --prod /app/deploy

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/deploy ./
EXPOSE 3001
CMD ["node", "dist/main.js"]
