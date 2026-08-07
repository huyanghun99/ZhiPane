FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/editor/package.json packages/editor/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/shared/src packages/shared/src
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/editor/src packages/editor/src
COPY --from=build /app/packages/editor/package.json packages/editor/package.json
COPY --from=build /app/packages/db/src packages/db/src
COPY --from=build /app/packages/db/package.json packages/db/package.json
COPY --from=build /app/packages/ai/src packages/ai/src
COPY --from=build /app/packages/ai/package.json packages/ai/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/server/src/db/migrations apps/server/src/db/migrations
EXPOSE 39280
CMD ["npx", "tsx", "apps/server/src/index.ts"]
