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
# NOTE: pnpm v10 changed `pnpm deploy` to only work on workspaces with
# inject-workspace-packages=true, erroring with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE
# otherwise. This monorepo does not inject, so pass --legacy to keep the pnpm-9
# bundling behavior (produces a self-contained /app/deploy with @clearview/shared).
RUN pnpm --filter @clearview/shared build \
  && pnpm --filter @clearview/api build \
  && pnpm --filter @clearview/api deploy --prod --legacy /app/deploy

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/deploy ./
EXPOSE 3001
# Container-level liveness (Render also uses healthCheckPath: /health). Uses Node 22's global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run as a Render pre-deploy (node db/migrate.mjs); the app runs as clearview_login.
CMD ["node", "dist/main.js"]
