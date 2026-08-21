"""
Voice-chat streamer service (headless — no bot token).

Logs in the ASSISTANT user account, joins group voice chats, and streams audio
via WebRTC (py-tgcalls). Your existing management bot drives it over this small
HTTP API, so users only ever talk to ONE bot.

Endpoints (all POST JSON unless noted; send header  X-Token: <STREAMER_TOKEN>):
  /play    {chat_id, query}   → search + play or enqueue
  /skip    {chat_id}          → next in queue (or leave if empty)
  /pause   {chat_id}
  /resume  {chat_id}
  /stop    {chat_id}          → clear queue + leave + end the voice chat
  /startvc {chat_id}          → open a voice chat
  /stopvc  {chat_id}          → close the voice chat
  /queue   {chat_id}          → current + upcoming
  /health  (GET)              → {ok: true}

The assistant must be an admin with the "manage voice chats" right.
"""
import asyncio
import logging

# py-tgcalls' sync shim calls asyncio.get_event_loop() at import time, which
# raises "no current event loop" on Python 3.12+ (default on newer distros).
# Ensure a current loop exists BEFORE importing pytgcalls/pyrogram.
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

from aiohttp import web
from pytgcalls.exceptions import NoActiveGroupCall
from pytgcalls.types import MediaStream

import config
import queue_manager as qm
from call_control import end_call, start_call
from clients import assistant, calls
from youtube import search

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("streamer")

routes = web.RouteTableDef()


def _audio(url: str) -> MediaStream:
    return MediaStream(url, video_flags=MediaStream.Flags.IGNORE)


async def _play_now(chat_id: int, track: dict) -> None:
    """Stream a track, opening the voice chat first if none is active."""
    try:
        await calls.play(chat_id, _audio(track["url"]))
    except NoActiveGroupCall:
        await start_call(assistant, chat_id)
        await calls.play(chat_id, _audio(track["url"]))


def _authorized(request: web.Request) -> bool:
    if not config.STREAMER_TOKEN:
        return True
    return request.headers.get("X-Token") == config.STREAMER_TOKEN


async def _body(request: web.Request) -> dict:
    try:
        return await request.json()
    except Exception:
        return {}


def _track_info(track: dict) -> dict:
    return {"title": track.get("title"), "duration": track.get("duration", 0), "webpage": track.get("webpage", "")}


@routes.get("/health")
async def health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


@routes.post("/play")
async def play(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    data = await _body(request)
    chat_id, query = data.get("chat_id"), (data.get("query") or "").strip()
    if not chat_id or not query:
        return web.json_response({"ok": False, "error": "bad_request"}, status=400)
    chat_id = int(chat_id)

    track = await search(query)
    if not track or not track.get("url"):
        return web.json_response({"ok": False, "error": "not_found"})

    # Play immediately, replacing whatever is currently on. (Simple + robust —
    # no queue/auto-advance, which was fragile on this py-tgcalls version.)
    qm.set_active(chat_id, track)
    try:
        await _play_now(chat_id, track)
    except Exception as e:
        qm.clear(chat_id)
        return web.json_response({"ok": False, "error": str(e)})
    return web.json_response({"ok": True, "queued": False, **_track_info(track)})


@routes.post("/skip")
async def skip(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    nxt = qm.next_track(chat_id)
    if not nxt:
        qm.clear(chat_id)
        try:
            await calls.leave_call(chat_id)
        except Exception:
            pass
        return web.json_response({"ok": True, "ended": True})
    try:
        await calls.play(chat_id, _audio(nxt["url"]))
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})
    return web.json_response({"ok": True, "ended": False, **_track_info(nxt)})


@routes.post("/pause")
async def pause(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    try:
        await calls.pause(chat_id)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


@routes.post("/resume")
async def resume(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    try:
        await calls.resume(chat_id)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


@routes.post("/stop")
async def stop(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    qm.clear(chat_id)
    try:
        await calls.leave_call(chat_id)
    except Exception:
        pass
    try:
        await end_call(assistant, chat_id)
    except Exception:
        pass
    return web.json_response({"ok": True})


@routes.post("/startvc")
async def startvc(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    try:
        await start_call(assistant, chat_id)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


@routes.post("/stopvc")
async def stopvc(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    qm.clear(chat_id)
    try:
        await calls.leave_call(chat_id)
    except Exception:
        pass
    try:
        ended = await end_call(assistant, chat_id)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})
    return web.json_response({"ok": True, "ended": ended})


@routes.post("/queue")
async def queue(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    cur = qm.active(chat_id)
    return web.json_response({
        "ok": True,
        "active": _track_info(cur) if cur else None,
        "upcoming": [_track_info(t) for t in qm.upcoming(chat_id)],
    })


def _udp_ok() -> bool:
    """Log whether outbound UDP works here (WebRTC needs it)."""
    try:
        from udptest import check
        return check()
    except Exception as e:
        log.warning("UDP check failed to run: %s", e)
        return False


async def _serve() -> None:
    # WebRTC needs outbound UDP; log at boot so any host's logs reveal instantly
    # whether it will work here.
    log.info("Checking outbound UDP (needed for WebRTC voice)…")
    _udp_ok()

    # Start the HTTP control API FIRST so /health and /play (search) work even
    # if the assistant can't connect — search is independent of the session, and
    # this avoids a crash loop when the session is temporarily invalid.
    app = web.Application()
    app.add_routes(routes)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", config.PORT)
    await site.start()
    log.info("HTTP control API listening on 0.0.0.0:%s", config.PORT)

    # Connect the assistant + PyTgCalls (needed for actual playback). Do NOT
    # crash the whole service if this fails — keep serving so search still works
    # and the session can be fixed without the container crash-looping.
    try:
        await assistant.start()
        await calls.start()
        me = await assistant.get_me()
        log.info("Streamer up. Assistant: %s (id %s). PyTgCalls started.", me.first_name, me.id)
    except Exception as e:
        log.error("Assistant/PyTgCalls failed to start — playback disabled until the session is fixed: %s", e)

    await asyncio.Event().wait()  # serve forever


def _setup_cookies() -> None:
    """If YT_COOKIES_CONTENT is set (a Netscape cookies.txt), write it to a file
    and point yt-dlp at it. Cookies let YouTube work from a datacenter IP."""
    import os as _os
    content = _os.getenv("YT_COOKIES_CONTENT")
    if not content:
        return
    path = "/tmp/yt_cookies.txt"
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        _os.environ["YT_COOKIES"] = path
        log.info("YouTube cookies loaded (%d bytes).", len(content))
    except Exception as e:
        log.warning("failed to write cookies file: %s", e)


def main() -> None:
    config.validate()
    _setup_cookies()
    loop = asyncio.get_event_loop()
    loop.run_until_complete(_serve())


if __name__ == "__main__":
    main()
