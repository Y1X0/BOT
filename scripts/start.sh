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
npx prisma generate

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

echo "[start] launching bot"
exec node dist/index.js
