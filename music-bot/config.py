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
START_DELAY = _int("STREAMER_START_DELAY", 12)


def _chat_set(name: str) -> set:
    """Parse a comma/space-separated list of chat ids into a set of ints."""
    raw = os.getenv(name, "") or ""
    out = set()
    for tok in raw.replace(",", " ").split():
        try:
            out.add(int(tok))
        except ValueError:
            continue
    return out


# Allow-list of group chat ids the streamer will act on. When set, any request
# for a chat_id NOT in this set is rejected (403). This scopes the assistant to
# the intended group(s), so a leaked STREAMER_URL/TOKEN can't drive it into
# random chats. Empty = allow all (with a boot warning).
ALLOWED_CHATS = _chat_set("STREAMER_ALLOWED_CHATS")


def chat_allowed(chat_id: int) -> bool:
    return not ALLOWED_CHATS or int(chat_id) in ALLOWED_CHATS


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
