"""YouTube search + audio-stream resolution via yt-dlp."""
import asyncio
from typing import Optional

import yt_dlp

_YDL_OPTS = {
    "format": "bestaudio/best",
    "noplaylist": True,
    "quiet": True,
    "no_warnings": True,
    "default_search": "ytsearch",
    "geo_bypass": True,
    "nocheckcertificate": True,
    "source_address": "0.0.0.0",
}


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
    except Exception:
        return None


def fmt_duration(seconds: int) -> str:
    seconds = int(seconds or 0)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"
