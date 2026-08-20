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
from pytgcalls import PyTgCalls
from pytgcalls import filters as call_filters
from pytgcalls.exceptions import NoActiveGroupCall
from pytgcalls.types import MediaStream, Update

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

    if qm.active(chat_id):
        pos = qm.enqueue(chat_id, track)
        return web.json_response({"ok": True, "queued": True, "position": pos, **_track_info(track)})

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


# Auto-advance to the next queued track when one finishes.
@calls.on_update(call_filters.stream_end)
async def on_stream_end(_: PyTgCalls, update: Update):
    chat_id = update.chat_id
    nxt = qm.next_track(chat_id)
    if not nxt:
        try:
            await calls.leave_call(chat_id)
        except Exception:
            pass
        return
    try:
        await calls.play(chat_id, _audio(nxt["url"]))
    except Exception as e:
        log.warning("auto-advance failed in %s: %s", chat_id, e)


async def _on_startup(_: web.Application) -> None:
    await assistant.start()
    await calls.start()
    me = await assistant.get_me()
    log.info("Streamer up. Assistant: %s (id %s). PyTgCalls started.", me.first_name, me.id)


def main() -> None:
    config.validate()
    app = web.Application()
    app.add_routes(routes)
    app.on_startup.append(_on_startup)
    web.run_app(app, host="0.0.0.0", port=config.PORT)


if __name__ == "__main__":
    main()
