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

# openssl for Prisma; ffmpeg + yt-dlp for the audio feature.
# Use the nightly build — it tracks YouTube extractor fixes far more closely
# than the stable release, which matters for bot-detection bypass.
RUN apt-get update -y \
    && apt-get install -y openssl ffmpeg ca-certificates wget fonts-noto-core fonts-dejavu-core \
    && wget -q https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
COPY scripts ./scripts
# Only production deps in the final image.
RUN npm ci --omit=dev && node scripts/set-db-provider.mjs && npx prisma generate && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Persist SQLite data (mount a volume here in production if using SQLite).
RUN mkdir -p /app/data
EXPOSE 3000

# On start: set provider from env, (re)generate client for that provider,
# sync the schema (creates missing tables — idempotent), then launch.
CMD ["sh", "-c", "node scripts/set-db-provider.mjs && npx prisma generate && npx prisma db push --accept-data-loss --skip-generate && node dist/index.js"]
