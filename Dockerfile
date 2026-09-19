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
# System Chromium for HTML→PDF and the image "id" card. Never let playwright
# download its own browser — use the apt one below.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PDF_CHROME_PATH=/usr/bin/chromium

# openssl for Prisma; ffmpeg + yt-dlp for audio; chromium for rendering.
# Font packages give Chromium real glyphs: noto-core (Latin), noto-color-emoji
# (the card's 👑🔥 etc.), dejavu, and noto Arabic as a system fallback.
# Use the nightly yt-dlp — it tracks YouTube extractor fixes far more closely.
RUN apt-get update -y \
    && apt-get install -y openssl ffmpeg ca-certificates wget \
       chromium fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
    && wget -q https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN chmod +x scripts/start.sh
# Only production deps in the final image.
RUN npm ci --omit=dev && node scripts/set-db-provider.mjs && npx prisma generate && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Bundled fonts (color-emoji) — registered at runtime by the id-card renderer.
COPY assets ./assets

# Persist SQLite data (mount a volume here in production if using SQLite).
RUN mkdir -p /app/data
EXPOSE 3000

# On start: set provider from env, (re)generate client, sync the schema
# (retried to ride out a Neon cold start), then launch. See scripts/start.sh —
# it starts the bot even if the DB is briefly unreachable, so a Neon hiccup
# can't turn into a crash loop that takes the whole bot offline.
CMD ["sh", "scripts/start.sh"]
