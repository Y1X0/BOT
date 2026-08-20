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

_BASE_OPTS = {
    "format": "bestaudio/best",
    "noplaylist": True,
    "quiet": True,
    "no_warnings": True,
    "geo_bypass": True,
    "nocheckcertificate": True,
    "cachedir": False,
    "extractor_args": {"youtube": {"player_client": ["android", "web_safari", "web"]}},
    "http_headers": {
        "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip",
    },
}


def _opts(prefix: str) -> dict:
    o = dict(_BASE_OPTS, default_search=prefix)
    if os.getenv("YT_COOKIES"):
        o["cookiefile"] = os.getenv("YT_COOKIES")
    return o


def _track(info: dict) -> Optional[dict]:
    if "entries" in info:
        entries = [e for e in info["entries"] if e]
        if not entries:
            return None
        info = entries[0]
    if not info or not info.get("url"):
        return None
    return {
        "title": info.get("title", "غير معروف"),
        "url": info.get("url"),
        "duration": info.get("duration") or 0,
        "webpage": info.get("webpage_url", ""),
        "thumb": info.get("thumbnail", ""),
        "uploader": info.get("uploader", ""),
    }


def _extract(query: str) -> Optional[dict]:
    is_url = query.startswith("http://") or query.startswith("https://")
    # Direct URL → resolve as-is. Otherwise search YouTube, then fall back to
    # SoundCloud (which, unlike YouTube, doesn't block datacenter/cloud IPs).
    prefixes = ["ytsearch"] if is_url else ["ytsearch", "scsearch"]
    last_err: Optional[Exception] = None
    for prefix in prefixes:
        try:
            with yt_dlp.YoutubeDL(_opts(prefix)) as ydl:
                info = ydl.extract_info(query, download=False)
            track = _track(info) if info else None
            if track:
                return track
        except Exception as e:
            last_err = e
            log.warning("%s failed for %r: %s", prefix, query, str(e)[:200])
    if last_err:
        raise last_err
    return None


async def search(query: str) -> Optional[dict]:
    """Resolve a playable track: YouTube search/URL, falling back to SoundCloud."""
    try:
        return await asyncio.to_thread(_extract, query)
    except Exception as e:
        log.warning("search failed for %r: %s", query, str(e)[:300])
        return None


def fmt_duration(seconds: int) -> str:
    seconds = int(seconds or 0)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"
