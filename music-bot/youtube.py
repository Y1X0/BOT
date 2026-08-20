"""YouTube search + audio-stream resolution via yt-dlp."""
import asyncio
import logging
from typing import Optional

import yt_dlp

log = logging.getLogger("youtube")

# YouTube blocks datacenter IPs (Railway etc.) on the default web client with a
# "Sign in to confirm you're not a bot" wall. The android/web_safari clients
# avoid that check most of the time. A cookies file (YT_COOKIES path) is used
# when provided, which is the most reliable bypass.
import os

_YDL_OPTS = {
    "format": "bestaudio/best",
    "noplaylist": True,
    "quiet": True,
    "no_warnings": True,
    "default_search": "ytsearch",
    "geo_bypass": True,
    "nocheckcertificate": True,
    "cachedir": False,
    "extractor_args": {"youtube": {"player_client": ["android", "web_safari", "web"]}},
    "http_headers": {
        "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip",
    },
}
if os.getenv("YT_COOKIES"):
    _YDL_OPTS["cookiefile"] = os.getenv("YT_COOKIES")


def _extract(query: str) -> Optional[dict]:
    with yt_dlp.YoutubeDL(_YDL_OPTS) as ydl:
        info = ydl.extract_info(query, download=False)
        if not info:
            return None
        if "entries" in info:
            entries = [e for e in info["entries"] if e]
            if not entries:
                return None
            info = entries[0]
        return {
            "title": info.get("title", "غير معروف"),
            "url": info.get("url"),            # direct audio stream URL for ffmpeg
            "duration": info.get("duration") or 0,
            "webpage": info.get("webpage_url", ""),
            "thumb": info.get("thumbnail", ""),
            "uploader": info.get("uploader", ""),
        }


async def search(query: str) -> Optional[dict]:
    """Search YouTube (or resolve a URL) and return a playable track dict."""
    try:
        return await asyncio.to_thread(_extract, query)
    except Exception as e:
        log.warning("yt-dlp search failed for %r: %s", query, str(e)[:300])
        return None


def fmt_duration(seconds: int) -> str:
    seconds = int(seconds or 0)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"
