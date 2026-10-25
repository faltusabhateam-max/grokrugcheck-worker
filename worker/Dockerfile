# Build from /workspace/grokrugcheck (repo root):  docker build -f worker/Dockerfile -t grokrugcheck-worker .
FROM node:20-slim
WORKDIR /srv
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --omit=dev && npm i tsx
COPY app/lib ./app/lib
COPY worker/src ./worker/src
RUN ln -s /srv/worker/node_modules /srv/app/node_modules
WORKDIR /srv/worker
ENV NODE_ENV=production
# Required env: BLOB_READ_WRITE_TOKEN, PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_SIGNER_ID
# Optional: SOLANA_RPC_URL (paid RPC recommended), DRY_RUN=1 for no-signing test mode, LOOP_MS (default 30000), XAI_API_KEY
CMD ["npx", "tsx", "src/index.ts"]
