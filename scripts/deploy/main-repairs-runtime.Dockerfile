FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=1 update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY dist ./dist
COPY node_modules ./node_modules
COPY drizzle ./drizzle
COPY package.json main-repairs-manifest.json ./
COPY scripts/deploy/main-repairs-guard.mjs ./scripts/deploy/main-repairs-guard.mjs
RUN node scripts/deploy/main-repairs-guard.mjs --runtime /app \
  && node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.prepare('select 1').get();db.close()"
ENV NODE_ENV=production DATA_DIR=/app/data HOST=0.0.0.0 PORT=4000
EXPOSE 4000
CMD ["sh", "-c", "node scripts/deploy/main-repairs-guard.mjs --runtime /app && node dist/server/db/migrate.js && exec node dist/server/index.js"]
