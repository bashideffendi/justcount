# Just Count — Dockerfile (bypass Nixpacks karena cache mount EBUSY bug)
# Pin Node 20 LTS biar better-sqlite3 prebuilt binary ke-pickup.

FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies (lockfile-based, no dev deps)
# --no-audit + --prefer-offline biar lebih cepat
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --prefer-offline && \
    npm cache clean --force

# Copy source
COPY . .

# Railway set PORT env; expose for clarity
ENV NODE_ENV=production
EXPOSE 3000

# Healthcheck endpoint (server.js handles /healthz)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
