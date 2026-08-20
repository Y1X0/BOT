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
# Leave empty to disable auth (only safe on a private network).
STREAMER_TOKEN = os.getenv("STREAMER_TOKEN", "")

# HTTP port the control API listens on.
PORT = _int("PORT", 8080)


def validate() -> None:
    missing = [n for n, v in {
        "API_ID": API_ID,
        "API_HASH": API_HASH,
        "SESSION_STRING": SESSION_STRING,
    }.items() if not v]
    if missing:
        raise SystemExit(
            "❌ ناقص متغيرات البيئة: " + ", ".join(missing) +
            "\nعبّيها بملف .env (شوف .env.example) قبل التشغيل."
        )
