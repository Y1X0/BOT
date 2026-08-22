"""Environment configuration for the voice-chat streamer service.

This service has NO bot token — it only logs in the ASSISTANT user account and
streams audio into voice chats. Your existing management bot controls it over a
small HTTP API (see main.py), so users interact with ONE bot.
"""
import os

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int = 0) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# From https://my.telegram.org → API development tools
API_ID = _int("API_ID")
API_HASH = os.getenv("API_HASH", "")

# The assistant USER account's Pyrogram string session (python gen_session.py).
SESSION_STRING = os.getenv("SESSION_STRING", "")

# Shared secret: the management bot must send this in the X-Token header.
# REQUIRED — the service has a public URL, so requests must be authenticated.
STREAMER_TOKEN = os.getenv("STREAMER_TOKEN", "")

# HTTP port the control API listens on.
PORT = _int("PORT", 8080)

# Seconds to wait before connecting the assistant on startup. Lets a previous
# deployment fully shut down first, so a redeploy doesn't briefly run two
# instances on the same session (which Telegram kills with AUTH_KEY_DUPLICATED).
# 12s wasn't enough against Railway's deploy overlap — default to 25s. Also set
# the platform's zero-downtime/overlap window to 0 and keep replicas at 1.
START_DELAY = _int("STREAMER_START_DELAY", 25)

# The management bot's public callback (e.g. https://your-bot.up.railway.app/vc/nowplaying).
# When set, the streamer notifies the bot on auto-advance so it can post the
# now-playing card. Authenticated with STREAMER_TOKEN. Optional.
BOT_CALLBACK_URL = os.getenv("BOT_CALLBACK_URL", "")

# The archive storage channel the assistant copies imported audio into (the bot
# is admin there and indexes it). Same id the bot uses as MUSIC_STORAGE_CHANNEL_ID.
MUSIC_STORAGE_CHANNEL_ID = _int("MUSIC_STORAGE_CHANNEL_ID", 0)


def validate() -> None:
    missing = [n for n, v in {
        "API_ID": API_ID,
        "API_HASH": API_HASH,
        "SESSION_STRING": SESSION_STRING,
        "STREAMER_TOKEN": STREAMER_TOKEN,
    }.items() if not v]
    if missing:
        raise SystemExit(
            "❌ ناقص متغيرات البيئة: " + ", ".join(missing) +
            "\nعبّيها بملف .env (شوف .env.example) قبل التشغيل."
        )
