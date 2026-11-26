# agent-relay server. Node runs the TypeScript sources directly (type stripping), no build step.
FROM node:22-slim
ENV NODE_ENV=production \
    RELAY_DB=/data/relay.db \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=4954
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY src ./src
COPY bin ./bin
RUN install -d -o node -g node /data
USER node
EXPOSE 4954
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.RELAY_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.ts"]
