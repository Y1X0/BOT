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
    # Prefer a continuous HTTP audio stream with a real audio codec. NO "/best":
    # that can return a full video, and the stream is built video-IGNORE, so it
    # plays silent. The android client hands back fragmented HLS/DASH URLs that
    # ffmpeg opens but produces no audio from — so we exclude manifests here and
    # also reject them in _track as a backstop.
    "format": "bestaudio[protocol^=http][acodec!=none]/bestaudio[ext=m4a]/bestaudio",
    "noplaylist": True,
    "quiet": True,
    "no_warnings": True,
    "geo_bypass": True,
    "nocheckcertificate": True,
    "cachedir": False,
    # Client order matters on flagged datacenter IPs (Render/Railway), where the
    # web clients hit the "Sign in to confirm you're not a bot" wall and return
    # nothing. `ios` bypasses that wall AND returns progressive (non-manifest)
    # audio, so it goes first; `tv_embedded` is the next best wall-bypasser.
    # `android` is kept last because it usually returns HLS manifests that stream
    # silent (rejected in _track), so it's a source of "found but unplayable".
    "extractor_args": {
        "youtube": {"player_client": ["ios", "web_safari", "tv_embedded", "web", "android"]}
    },
    # A normal browser UA — the previous YouTube-app UA broke SoundCloud's
    # client_id extraction. YouTube uses its own client via extractor_args.
    "http_headers": {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
    },
}


def _opts(prefix: str) -> dict:
    o = dict(_BASE_OPTS, default_search=prefix)
    if os.getenv("YT_COOKIES"):
        o["cookiefile"] = os.getenv("YT_COOKIES")
    return o


def _is_manifest(entry: dict) -> bool:
    """Fragmented HLS/DASH — ffmpeg opens it but no audio comes out.

    Search entries don't always populate `protocol`, so also sniff the ext and
    the URL (HLS/DASH URLs carry .m3u8 / .mpd).
    """
    proto = (entry.get("protocol") or "").lower()
    ext = (entry.get("ext") or "").lower()
    url = (entry.get("url") or "").lower()
    return (
        "m3u8" in proto or "dash" in proto
        or ext in ("m3u8", "mpd")
        or ".m3u8" in url or ".mpd" in url
    )


def _track(info: dict) -> Optional[dict]:
    entries = [e for e in info["entries"] if e] if "entries" in info else [info]
    saw_entries = False
    saw_manifest_only = False
    for entry in entries:
        if not entry:
            continue
        saw_entries = True
        if not entry.get("url"):
            continue
        if _is_manifest(entry):
            saw_manifest_only = True
            log.info("skipping manifest result %r (proto=%s)", entry.get("title"), entry.get("protocol"))
            continue
        log.info(
            "track: %s | ext=%s acodec=%s proto=%s",
            entry.get("title"), entry.get("ext"), entry.get("acodec"), entry.get("protocol"),
        )
        return {
            "title": entry.get("title", "غير معروف"),
            "url": entry.get("url"),
            "duration": entry.get("duration") or 0,
            "webpage": entry.get("webpage_url", ""),
            "thumb": entry.get("thumbnail", ""),
            "uploader": entry.get("uploader", ""),
        }
    if saw_manifest_only:
        log.warning("all results were HLS/DASH manifests (silent) — no progressive audio; try the ios/tv client or YT_COOKIES")
    elif not saw_entries:
        log.warning("search returned zero entries (likely a bot-wall / geo block on this IP)")
    return None


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
