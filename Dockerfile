# ---- Build stage ----------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# System deps needed by Prisma engine.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
# Install ALL deps (incl. dev) for the build.
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build

# ---- Runtime stage --------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
COPY scripts ./scripts
# Only production deps in the final image.
RUN npm ci --omit=dev && node scripts/set-db-provider.mjs && npx prisma generate && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Persist SQLite data (mount a volume here in production if using SQLite).
RUN mkdir -p /app/data
EXPOSE 3000

# Set provider, run migrations (fall back to db push for SQLite), then start.
CMD ["sh", "-c", "node scripts/set-db-provider.mjs && (npx prisma migrate deploy 2>/dev/null || npx prisma db push --skip-generate); node dist/index.js"]
