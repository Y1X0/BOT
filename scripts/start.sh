#!/bin/sh
# Container entrypoint.
#
# Why a script instead of chaining with `&&` in the Dockerfile CMD:
# the database lives on Neon's free tier, whose compute endpoint suspends
# after inactivity and can take 10-30s to wake (Prisma reports P1001 while
# it is asleep). With a bare `prisma db push && node dist/index.js`, a single
# cold-start miss kills the whole process, Render restarts the container, and
# it fails the same way — a crash loop that takes the bot fully offline.
#
# Instead we retry `db push` with backoff to ride out a cold start, and if it
# still can't reach the DB we START THE BOT ANYWAY. Prisma connects lazily, so
# the bot stays alive and recovers on its own the moment Neon comes back,
# instead of depending on Render's restart timing.

set -e

echo "[start] setting db provider from env"
node scripts/set-db-provider.mjs

echo "[start] generating prisma client"
# Guard against a hung `prisma generate` (seen stalling >10min, blocking boot):
# cap each try and retry a couple of times before giving up and starting anyway
# (the build already generated a client, so a stale one still lets the bot run).
gi=1
while [ "$gi" -le 3 ]; do
  if timeout 120 npx prisma generate; then break; fi
  echo "[start] prisma generate attempt $gi timed out/failed; retrying"
  gi=$((gi + 1))
done

# Retry db push to survive a Neon cold start. Backoff: 3s,6s,9s,12s,15s (~45s).
i=1
max=5
pushed=0
while [ "$i" -le "$max" ]; do
  echo "[start] prisma db push (attempt $i/$max)"
  if npx prisma db push --accept-data-loss --skip-generate; then
    echo "[start] schema in sync ✅"
    pushed=1
    break
  fi
  if [ "$i" -lt "$max" ]; then
    wait=$((i * 3))
    echo "[start] db unreachable, retrying in ${wait}s…"
    sleep "$wait"
  fi
  i=$((i + 1))
done

if [ "$pushed" -ne 1 ]; then
  echo "[start] ⚠️ could not reach the database after ${max} attempts."
  echo "[start] ⚠️ starting the bot anyway — it will connect once the DB is back."
fi

# Embedded voice-chat streamer (opt-in). When EMBED_STREAMER=true and the
# assistant SESSION_STRING is present, run the Python streamer beside the bot in
# this same always-on container — so «الكول» is always ready with no separate
# service and no cold start. A watchdog restarts it if it dies; the bot stays the
# container's main process, so its health/keepalive keeps the whole thing awake.
if [ "$EMBED_STREAMER" = "true" ] && [ -n "$SESSION_STRING" ]; then
  echo "[start] EMBED_STREAMER=true → launching embedded voice streamer"
  # The bot talks to it on localhost; keep these consistent with the bot's env.
  export PORT_STREAMER="${PORT_STREAMER:-8080}"
  export STREAMER_START_DELAY="${STREAMER_START_DELAY:-0}"
  (
    cd music-bot || exit 0
    while true; do
      echo "[streamer] starting (port ${PORT_STREAMER})"
      PORT="$PORT_STREAMER" PYTHONUNBUFFERED=1 /opt/streamer-venv/bin/python main.py || true
      echo "[streamer] exited — restarting in 5s"
      sleep 5
    done
  ) &
elif [ "$EMBED_STREAMER" = "true" ]; then
  echo "[start] ⚠️ EMBED_STREAMER=true but SESSION_STRING is empty — streamer NOT started"
fi

# Cloudflare WARP egress (opt-in). Routes yt-dlp through Cloudflare's network —
# a different IP than our datacenter one, which YouTube bot-walls — via userspace
# WireGuard (wgcf + wireproxy), so no root/TUN. The WARP account + profile are
# cached on the persistent disk, so we register only once. Fully best-effort: if
# anything here fails the bot still starts normally (YT_PROXY would just point at
# a dead port and yt-dlp falls back to its other methods). Enable with
# WARP_ENABLED=true and set YT_PROXY=socks5://127.0.0.1:40000 so yt-dlp uses it.
if [ "$WARP_ENABLED" = "true" ]; then
  echo "[start] WARP_ENABLED=true → bringing up Cloudflare WARP (wireproxy)"
  WARP_DIR="${WARP_DIR:-/app/data/warp}"
  WARP_BIND="${WARP_BIND:-127.0.0.1:40000}"
  APP_DIR="$(pwd)"
  mkdir -p "$WARP_DIR" || true
  (
    set +e
    cd "$WARP_DIR" || exit 0

    # Reuse the WARP profile saved in the DB so we register with Cloudflare only
    # ONCE ever. The free tier has no persistent disk, so re-registering on every
    # deploy quickly hits Cloudflare's rate limit (HTTP 429) and leaves WARP down.
    # If none is saved yet, register and persist it; keep retrying so a transient
    # 429 self-heals in the background without needing a redeploy.
    until [ -s wgcf-profile.conf ]; do
      node "$APP_DIR/scripts/warp-profile.mjs" get > wgcf-profile.conf 2>/dev/null || true
      if [ -s wgcf-profile.conf ]; then
        echo "[warp] loaded saved WARP profile from DB (no registration needed)"
        break
      fi
      rm -f wgcf-profile.conf wgcf-account.toml
      echo "[warp] no saved profile → registering a new WARP account"
      wgcf register --accept-tos >/dev/null 2>&1 && wgcf generate >/dev/null 2>&1
      if [ -s wgcf-profile.conf ]; then
        node "$APP_DIR/scripts/warp-profile.mjs" save wgcf-profile.conf 2>/dev/null \
          && echo "[warp] registered + saved WARP profile to DB for future deploys"
        break
      fi
      echo "[warp] ⚠️ registration unavailable (likely 429) — retrying in 120s"
      sleep 120
    done

    # wireproxy config = the WireGuard profile + a local SOCKS5 listener.
    { cat wgcf-profile.conf; printf '\n[Socks5]\nBindAddress = %s\n' "$WARP_BIND"; } > wireproxy.conf
    echo "[warp] starting wireproxy SOCKS5 on ${WARP_BIND}"
    # Watchdog: always bring wireproxy back if it ever exits.
    (
      while true; do
        wireproxy -c wireproxy.conf
        echo "[warp] ⚠️ wireproxy exited — restarting in 5s"
        sleep 5
      done
    ) &
    port="${WARP_BIND##*:}"
    n=1
    while [ "$n" -le 15 ]; do
      if node -e "require('net').connect({host:'127.0.0.1',port:${port}},()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
        echo "[warp] ✅ SOCKS5 proxy up on ${WARP_BIND} — yt-dlp will egress via Cloudflare"
        break
      fi
      sleep 1; n=$((n + 1))
    done
    [ "$n" -gt 15 ] && echo "[warp] ⚠️ wireproxy did not come up in time"
  ) &
fi

echo "[start] launching bot"
exec node dist/index.js
