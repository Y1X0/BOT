"""Environment configuration for the voice-chat music bot."""
import os

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int = 0) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# From https://my.telegram.org  → API development tools
API_ID = _int("API_ID")
API_HASH = os.getenv("API_HASH", "")

# A SEPARATE bot token from @BotFather (do NOT reuse the management bot's token —
# one token can only be polled by one process).
BOT_TOKEN = os.getenv("BOT_TOKEN", "")

# The assistant USER account's Pyrogram string session (generate with
# `python gen_session.py`). This account joins the voice chat and streams audio.
SESSION_STRING = os.getenv("SESSION_STRING", "")

# Your Telegram numeric id (optional; used for owner-only commands / logs).
OWNER_ID = _int("OWNER_ID")

# Command prefixes. "" lets bare Arabic words (تشغيل ...) act as commands.
PREFIXES = ["/", "!", ""]


def validate() -> None:
    missing = [n for n, v in {
        "API_ID": API_ID,
        "API_HASH": API_HASH,
        "BOT_TOKEN": BOT_TOKEN,
        "SESSION_STRING": SESSION_STRING,
    }.items() if not v]
    if missing:
        raise SystemExit(
            "❌ ناقص متغيرات البيئة: " + ", ".join(missing) +
            "\nعبّيها بملف .env (شوف .env.example) قبل التشغيل."
        )
