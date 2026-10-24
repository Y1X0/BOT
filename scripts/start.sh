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

# Download/extract to REAL DISK, not /tmp. On Render /tmp is tmpfs (RAM-backed),
# so writing a large media file there eats into the 512MB limit and OOM-restarts
# the bot mid-download (health check then times out). /app/data is real disk, so
# yt-dlp/ffmpeg temp files no longer count against RAM. os.tmpdir() honors TMPDIR.
export TMPDIR="${TMPDIR:-/app/data/tmp}"
mkdir -p "$TMPDIR" || true

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
  WARP_MAX_ROTATE="${WARP_MAX_ROTATE:-4}"
  APP_DIR="$(pwd)"
  mkdir -p "$WARP_DIR" || true
  (
    set +e
    cd "$WARP_DIR" || exit 0
    PORT_WARP="${WARP_BIND##*:}"
    WP_PID=""

    # Register a brand-new WARP account (= fresh exit IP) and persist the profile.
    warp_register() {
      rm -f wgcf-profile.conf wgcf-account.toml
      wgcf register --accept-tos >/dev/null 2>&1 && wgcf generate >/dev/null 2>&1
      [ -s wgcf-profile.conf ] || return 1
      node "$APP_DIR/scripts/warp-profile.mjs" save wgcf-profile.conf 2>/dev/null
      return 0
    }

    # (Re)start wireproxy on the current profile; wait for the SOCKS port to open.
    warp_start() {
      [ -n "$WP_PID" ] && kill "$WP_PID" 2>/dev/null
      sleep 1
      { cat wgcf-profile.conf; printf '\n[Socks5]\nBindAddress = %s\n' "$WARP_BIND"; } > wireproxy.conf
      wireproxy -c wireproxy.conf >/dev/null 2>&1 &
      WP_PID=$!
      i=0
      while [ "$i" -lt 15 ]; do
        node -e "require('net').connect({host:'127.0.0.1',port:${PORT_WARP}},()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && return 0
        sleep 1; i=$((i + 1))
      done
      return 1
    }

    # Does YouTube bot-wall this exit IP? Extraction-only probe (no download).
    warp_blocked() {
      out=$(timeout 45 yt-dlp --proxy "socks5://127.0.0.1:${PORT_WARP}" -J --no-warnings \
        --extractor-args "youtube:player_client=android" \
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>&1)
      echo "$out" | grep -qiE "sign in to confirm|not a bot|--cookies|confirm you"
    }

    # Start from the saved profile, unless WARP_RESET asks for a fresh one.
    if [ "$WARP_RESET" = "true" ]; then
      echo "[warp] WARP_RESET=true → starting from a fresh WARP IP"
      node "$APP_DIR/scripts/warp-profile.mjs" clear 2>/dev/null
      rm -f wgcf-profile.conf wgcf-account.toml
    else
      node "$APP_DIR/scripts/warp-profile.mjs" get > wgcf-profile.conf 2>/dev/null || true
      [ -s wgcf-profile.conf ] && echo "[warp] loaded saved WARP profile from DB"
    fi

    # Find an exit IP that YouTube does NOT bot-wall, rotating up to N times.
    # Registration is persisted so a clean IP is reused on future deploys; a 429
    # (rate limit) self-heals by waiting, so no redeploy is needed.
    rotations=0
    while :; do
      until [ -s wgcf-profile.conf ]; do
        echo "[warp] registering a new WARP account"
        if warp_register; then
          echo "[warp] registered + saved WARP profile to DB"
        else
          echo "[warp] ⚠️ registration unavailable (likely 429) — retrying in 120s"
          sleep 120
        fi
      done

      if ! warp_start; then
        echo "[warp] ⚠️ wireproxy did not come up — leaving watchdog to retry"
        break
      fi
      echo "[warp] ✅ SOCKS5 up on ${WARP_BIND}; probing whether YouTube blocks this IP…"

      if ! warp_blocked; then
        echo "[warp] ✅ exit IP is CLEAN — YouTube is not bot-walling it, downloads should work"
        break
      fi

      rotations=$((rotations + 1))
      if [ "$rotations" -ge "$WARP_MAX_ROTATE" ]; then
        echo "[warp] ⚠️ tried ${rotations} IPs, all bot-walled — keeping last. Downloads may fail; consider cookies."
        break
      fi
      echo "[warp] ⚠️ exit IP is bot-walled — rotating to a fresh IP (${rotations}/${WARP_MAX_ROTATE})"
      node "$APP_DIR/scripts/warp-profile.mjs" clear 2>/dev/null
      rm -f wgcf-profile.conf wgcf-account.toml
    done

    # Watchdog: keep wireproxy alive if it ever exits.
    while true; do
      if [ -n "$WP_PID" ] && kill -0 "$WP_PID" 2>/dev/null; then
        sleep 15
      else
        echo "[warp] ⚠️ wireproxy not running — restarting"
        wireproxy -c wireproxy.conf >/dev/null 2>&1 &
        WP_PID=$!
        sleep 15
      fi
    done
  ) &
fi

echo "[start] launching bot"
exec node dist/index.js
