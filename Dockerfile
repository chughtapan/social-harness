# Runs this commit's installed sharnessd without downloading code at startup.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /build
ENV HUSKY=0 NX_DAEMON=false NX_NO_CLOUD=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version nx.json tsconfig.json LICENSE README.md ./
COPY scripts/clean-dist.ts scripts/clean-dist.ts
COPY src/ src/
COPY examples/ examples/
COPY skills/ skills/
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
RUN pnpm install --frozen-lockfile --filter @social-harness/social-harness
RUN pnpm nx run @social-harness/social-harness:build
RUN pnpm deploy --filter @social-harness/social-harness --prod --legacy --ignore-scripts /deploy

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
LABEL org.opencontainers.image.source="https://github.com/chughtapan/social-harness"
LABEL org.opencontainers.image.description="Social Harness server"
COPY --from=build --chown=node:node /deploy/ /opt/social-harness/
USER node
ENTRYPOINT ["node", "/opt/social-harness/dist/main.js"]
