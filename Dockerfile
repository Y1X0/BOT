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
    && apt-get install -y openssl ffmpeg ca-certificates wget unzip zip \
       chromium fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
       python3 python3-venv \
    && wget -q https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    # Deno = JavaScript runtime yt-dlp needs to solve YouTube's JS challenge
    # (for the full-video download feature). Installed from GitHub releases.
    && wget -q https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -O /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod a+rx /usr/local/bin/deno \
    && rm -f /tmp/deno.zip \
    && rm -rf /var/lib/apt/lists/*

# bgutil PO-token plugin for yt-dlp. Paired with the separate `pot-provider`
# service, this lets yt-dlp pass YouTube's "Sign in to confirm you're not a bot"
# wall WITHOUT cookies: the plugin fetches a proof-of-origin token from the
# provider. The standalone yt-dlp binary loads it from this dir (passed via
# --plugin-dirs in the downloader when POT_PROVIDER_URL is set). The plugin uses
# only stdlib + yt-dlp internals, so it runs in the binary's bundled Python.
# Keep this version in lockstep with pot-provider/Dockerfile.
# NOTE the nesting: yt-dlp only picks up a plugin dir shaped as
# <plugin-dir>/<package>/yt_dlp_plugins/… — a bare <plugin-dir>/yt_dlp_plugins/
# is silently ignored. So unzip under a package subfolder (bgutil/); the
# downloader passes --plugin-dirs /app/ytdlp-plugins (the parent).
RUN mkdir -p /app/ytdlp-plugins/bgutil \
    && wget -q https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.2/bgutil-ytdlp-pot-provider.zip -O /tmp/pot.zip \
    && unzip -q /tmp/pot.zip -d /app/ytdlp-plugins/bgutil \
    && rm -f /tmp/pot.zip

# ---- Embedded PO-token provider (bgutil server) ---------------------------
# The yt-dlp plugin above fetches the token from a bgutil SERVER. Rather than a
# separate free service (which hibernates, wakes unreliably, and can't be kept
# awake without blowing the workspace's 750h/month free budget and suspending
# the bot), we run that server INSIDE this container on localhost — always warm,
# no cold start, no extra instance hours. It's a Node 22 app with a native
# `canvas` dependency, so we copy its prebuilt tree AND its Node 22 runtime from
# the official image, then add canvas's system libraries. Launched from
# start.sh when POT_EMBED=true. Keep the version in lockstep with the plugin zip.
COPY --from=brainicism/bgutil-ytdlp-pot-provider:2.0.2 /usr/local/bin/node /usr/local/bin/node22
COPY --from=brainicism/bgutil-ytdlp-pot-provider:2.0.2 /app /opt/bgutil-server
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
       libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Cloudflare WARP egress (optional, free). Routes yt-dlp through Cloudflare's
# network — a different IP than our datacenter one, which YouTube bot-walls —
# using userspace WireGuard (wgcf registers a free WARP account; wireproxy runs
# it and exposes a local SOCKS5 proxy). No root/TUN needed, so it works in this
# unprivileged container. Only used when WARP_ENABLED=true at runtime; otherwise
# the binaries just sit idle. See scripts/start.sh.
RUN wget -q https://github.com/ViRb3/wgcf/releases/download/v2.2.29/wgcf_2.2.29_linux_amd64 -O /usr/local/bin/wgcf \
    && chmod a+rx /usr/local/bin/wgcf \
    && wget -q https://github.com/whyvl/wireproxy/releases/download/v1.1.3/wireproxy_linux_amd64.tar.gz -O /tmp/wireproxy.tgz \
    && tar xzf /tmp/wireproxy.tgz -C /usr/local/bin wireproxy \
    && chmod a+rx /usr/local/bin/wireproxy \
    && rm -f /tmp/wireproxy.tgz

COPY package*.json ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN chmod +x scripts/start.sh
# Only production deps in the final image.
RUN npm ci --omit=dev && node scripts/set-db-provider.mjs && npx prisma generate && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Bundled fonts (color-emoji) — registered at runtime by the id-card renderer.
COPY assets ./assets

# ---- Embedded voice-chat streamer (optional) ------------------------------
# The Python streamer lives in the SAME image so, when EMBED_STREAMER=true, it
# runs beside the bot in one always-on service (no separate service to spin up,
# no cold start). Its deps go in an isolated venv so they never touch Node. When
# the flag is off, none of this runs — the bot behaves exactly as before.
COPY music-bot ./music-bot
RUN python3 -m venv /opt/streamer-venv \
    && /opt/streamer-venv/bin/pip install --no-cache-dir -r music-bot/requirements.txt

# Persist SQLite data (mount a volume here in production if using SQLite).
RUN mkdir -p /app/data
EXPOSE 3000

# On start: set provider from env, (re)generate client, sync the schema
# (retried to ride out a Neon cold start), then launch. See scripts/start.sh —
# it starts the bot even if the DB is briefly unreachable, so a Neon hiccup
# can't turn into a crash loop that takes the whole bot offline.
CMD ["sh", "scripts/start.sh"]
