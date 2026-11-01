# PO-token provider for the bot's yt-dlp (bgutil-ytdlp-pot-provider).
#
# This is a SEPARATE Render service. Its only job: generate YouTube
# proof-of-origin (PO) tokens so the bot's yt-dlp can pass the "Sign in to
# confirm you're not a bot" wall WITHOUT cookies. The heavy BotGuard/jsdom work
# runs here, off the bot's 512MB host.
#
# We extend the official prebuilt image (it already contains the compiled server
# plus the native canvas/jsdom build, so there's nothing to compile here) and
# only change how it starts, to fit Render:
#   - Render routes public traffic to $PORT (default 10000).
#   - The server honors only a --port flag (it does NOT read $PORT), and by
#     default binds loopback only, so we must pass --host 0.0.0.0 --port $PORT.
#
# Keep this version in lockstep with the plugin zip in the bot's Dockerfile.
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.2

# The base image's ENTRYPOINT is `node build/main.js`; reset it so our CMD is the
# whole command, and use a shell so ${PORT} expands (the base is a standard
# node:slim image, so /bin/sh is present). WORKDIR is /app.
ENTRYPOINT []
CMD ["sh", "-c", "node /app/build/main.js --host 0.0.0.0 --port ${PORT:-10000}"]
