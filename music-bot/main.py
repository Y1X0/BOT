"""
Voice-chat streamer service (headless — no bot token).

Logs in the ASSISTANT user account, joins group voice chats, and streams audio
via WebRTC (py-tgcalls). Your existing management bot drives it over this small
HTTP API, so users only ever talk to ONE bot.

Endpoints (all POST JSON unless noted; send header  X-Token: <STREAMER_TOKEN>):
  /join    {invite_link}       → assistant joins a group (rate-limited)
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
import random
import time
from urllib.parse import urlsplit

import aiohttp

# py-tgcalls' sync shim calls asyncio.get_event_loop() at import time, which
# raises "no current event loop" on Python 3.12+ (default on newer distros).
# Ensure a current loop exists BEFORE importing pytgcalls/pyrogram.
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

from aiohttp import web
from pytgcalls import filters as call_filters
from pytgcalls.types import MediaStream

from typing import Optional

import config
import queue_manager as qm
from call_control import NoAccess, call_is_open, end_call, start_call
from clients import assistant, calls
from youtube import search

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("streamer")

routes = web.RouteTableDef()

# True once the assistant + PyTgCalls are connected and playback is possible.
_ready = False

# Anti-flood for /join: joining many groups fast gets a user account banned by
# Telegram, so allow at most one join attempt per this many seconds (global,
# in-memory — good enough for a single streamer instance).
_JOIN_COOLDOWN = 60.0
_last_join = 0.0

# The assistant's own Telegram user id (set once at startup) — the management
# bot needs it to promote the assistant to admin after it joins.
_assistant_id = 0

# Bulk-import state. Conservative by design — a user account that copies too fast
# gets banned, so: one import at a time, slow random delays, a hard per-session
# cap, and a full stop on the first FloodWait.
_importing = False
_import_stop = False
IMPORT_MAX = 200          # hard cap per session
IMPORT_MIN_DELAY = 3.0    # seconds between copies (randomized up to +2)

# Strong refs to detached background tasks so the event loop's weak references
# don't let them be garbage-collected before they finish.
_bg_tasks: set = set()


def _spawn(coro) -> None:
    task = asyncio.ensure_future(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


def _audio(url: str) -> MediaStream:
    return MediaStream(url, video_flags=MediaStream.Flags.IGNORE)


async def _has_live_call(chat_id: int) -> bool:
    """True only if the assistant is really streaming in this chat right now.

    py-tgcalls exposes active calls via the async `calls` property, which
    returns Dict[int, Call] keyed by chat_id. We use this to detect a STALE
    _active entry: if queue_manager thinks something is playing but there is
    no live call (a WebRTC drop or error that never fired stream_end), every
    future /play would silently enqueue behind a track that will never advance.
    """
    try:
        active = await calls.calls
        return int(chat_id) in active
    except Exception as e:
        # If we can't tell, assume there IS a live call so we don't stomp a
        # real one — the enqueue path is the safe default here.
        log.info("could not read active calls for %s: %s", chat_id, e)
        return True


async def _log_playback_soon(chat_id: int) -> None:
    """After a play() succeeds, check whether audio is REALLY flowing.

    py-tgcalls has no stream_start event in this version, but Call.playback
    reflects the actual state: ACTIVE = ffmpeg is feeding audio, IDLE = the
    play() call "succeeded" yet nothing is streaming (e.g. a silent manifest).
    Runs detached so it never delays the HTTP response.
    """
    try:
        await asyncio.sleep(1.5)  # let frames start before we sample
        call = (await calls.calls).get(int(chat_id))
        state = getattr(call, "playback", None)
        if state is not None and "ACTIVE" in str(state):
            log.info("stream started in %s (playback=%s)", chat_id, state)
        else:
            log.warning("no audio flowing in %s (playback=%s) — likely a bad/silent stream", chat_id, state)
    except Exception as e:
        log.info("could not read playback state in %s: %s", chat_id, e)


async def _play_now(chat_id: int, track: dict) -> None:
    """Stream a track into an ALREADY-OPEN voice chat.

    This never opens or closes a call — that is /startvc's job. Opening a call
    here (CreateGroupCall) would DESTROY any running call and replace it, which
    caused an open/close loop when a track failed to start. The caller must
    verify a call is open (_require_open_call) before invoking this.

    We still retry a few times: a call just opened by /startvc may not be
    registered on Telegram's side yet. A fresh MediaStream is built per attempt
    (the object may hold state after a failed play).

    Recovery: py-tgcalls can get stuck thinking it's still joined from an old
    call (AlreadyJoinedError) after a WebRTC drop or an abruptly-closed call.
    On whichever attempt first hits that, leave_call clears the stale internal
    state (once — leaving repeatedly would churn), then the loop retries.
    """
    last: Optional[Exception] = None
    recovered = False
    for attempt in range(5):
        if attempt:
            await asyncio.sleep(1.5)  # let Telegram register a freshly-opened call
        try:
            await calls.play(chat_id, _audio(track["url"]))
            _spawn(_log_playback_soon(chat_id))  # detached audio-liveness check
            return
        except Exception as e:
            last = e
            log.info("play attempt %d in %s failed: %s: %s", attempt + 1, chat_id, type(e).__name__, e)
            if not recovered and (type(e).__name__ == "AlreadyJoinedError" or "already joined" in str(e).lower()):
                recovered = True
                log.info("stuck join in %s — leaving to clear stale state", chat_id)
                try:
                    await calls.leave_call(chat_id)
                except Exception as le:
                    log.info("leave_call during recovery in %s: %s", chat_id, le)
    raise last if last else RuntimeError("play failed")


def _authorized(request: web.Request) -> bool:
    # STREAMER_TOKEN is required (enforced in config.validate), so this always
    # checks the header — no open fallback.
    return request.headers.get("X-Token") == config.STREAMER_TOKEN


async def _body(request: web.Request) -> dict:
    # Parse the JSON body at most ONCE per request and cache it on the request
    # object, so a handler that reads it twice never triggers a second read()
    # that could fail mid-stream.
    if "_json" in request:
        return request["_json"]
    try:
        data = await request.json()
    except Exception:
        data = {}
    request["_json"] = data
    return data


def _track_info(track: dict) -> dict:
    return {
        "title": track.get("title"),
        "duration": track.get("duration", 0),
        "webpage": track.get("webpage", ""),
        "thumb": track.get("thumb", ""),
        "uploader": track.get("uploader", ""),
    }


async def _require_open_call(chat_id: int) -> Optional[web.Response]:
    """None if a voice chat is open in this chat; otherwise an error Response.

    Distinguishes "assistant isn't in the group" (PEER_ID_INVALID → the bot
    tells the user to run /vcjoin) from "no call is open" (no_call → open one
    with /vcstart). Playback/queue actions must never run without an open call.
    """
    try:
        if await call_is_open(assistant, chat_id):
            return None
    except NoAccess:
        return web.json_response({"ok": False, "error": "not_member"})
    return web.json_response({"ok": False, "error": "no_call"})


@routes.get("/")
@routes.get("/health")
async def health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


@routes.post("/play")
async def play(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    if not _ready:
        return web.json_response({"ok": False, "error": "starting"})
    data = await _body(request)
    chat_id, query = data.get("chat_id"), (data.get("query") or "").strip()
    if not chat_id or not query:
        return web.json_response({"ok": False, "error": "bad_request"}, status=400)
    chat_id = int(chat_id)

    # The call must already be open. /play must NEVER open (or close) a call —
    # doing so destroys a running one. If none is open, tell the user to open
    # one first, without searching or touching the queue.
    guard = await _require_open_call(chat_id)
    if guard is not None:
        return guard

    track = await search(query)
    if not track or not track.get("url"):
        return web.json_response({"ok": False, "error": "not_found"})

    # Something already playing → enqueue. But only trust queue_manager if a
    # real call is live; otherwise _active is STALE (a drop that never fired
    # stream_end) and we must play now instead of enqueuing into the void.
    if qm.active(chat_id) and await _has_live_call(chat_id):
        pos = qm.enqueue(chat_id, track)
        return web.json_response({"ok": True, "queued": True, "position": pos, **_track_info(track)})

    if qm.active(chat_id):
        log.info("stale active track in %s with no live call — playing directly", chat_id)
        qm.clear(chat_id)

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
    guard = await _require_open_call(chat_id)
    if guard is not None:
        return guard
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
    guard = await _require_open_call(chat_id)
    if guard is not None:
        return guard
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
    guard = await _require_open_call(chat_id)
    if guard is not None:
        return guard
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


@routes.post("/join")
async def join(request: web.Request) -> web.Response:
    """Make the assistant join a group via its invite link, so it can then be
    promoted to admin and stream. Rate-limited to avoid a Telegram ban."""
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    if not _ready:
        return web.json_response({"ok": False, "error": "starting"})
    data = await _body(request)
    invite = (data.get("invite_link") or "").strip()
    if not invite:
        return web.json_response({"ok": False, "error": "bad_request"}, status=400)
    want_id = data.get("chat_id")

    global _last_join
    now = time.monotonic()
    if now - _last_join < _JOIN_COOLDOWN:
        return web.json_response({"ok": False, "error": "too_fast"})

    try:
        chat = await assistant.join_chat(invite)
        # Every outcome below actually reached Telegram's join path, so it
        # counts toward the anti-flood cooldown — but a bad/expired link (in
        # the except) never resolved and must NOT burn the user's minute.
        _last_join = time.monotonic()
        # Safety: the invite must be for the SAME group the command came from.
        # Otherwise a moderator could point the assistant at an unrelated group.
        joined_id = getattr(chat, "id", None)
        if want_id and joined_id is not None and joined_id != int(want_id):
            try:
                await assistant.leave_chat(joined_id)
            except Exception:
                pass
            return web.json_response({"ok": False, "error": "wrong_group"})
        return web.json_response({"ok": True, "assistant_id": _assistant_id})
    except Exception as e:
        name = type(e).__name__
        log.info("join failed (%s): %s", name, e)
        if name in ("InviteHashExpired", "InviteHashInvalid", "InviteHashEmpty"):
            # Invite never resolved — not a real join attempt, don't cool down.
            return web.json_response({"ok": False, "error": "bad_link"})
        _last_join = time.monotonic()
        if name == "UserAlreadyParticipant":
            return web.json_response({"ok": True, "already": True, "assistant_id": _assistant_id})
        if name in ("UserBannedInChannel", "ChannelBanned", "ChatWriteForbidden"):
            return web.json_response({"ok": False, "error": "banned"})
        if name == "FloodWait":
            seconds = getattr(e, "value", None) or getattr(e, "x", None) or 0
            return web.json_response({"ok": False, "error": "flood_wait", "seconds": int(seconds)})
        return web.json_response({"ok": False, "error": str(e)})


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


@routes.post("/clearqueue")
async def clearqueue(request: web.Request) -> web.Response:
    """Clear the UPCOMING queue but keep the current track playing."""
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    chat_id = int((await _body(request)).get("chat_id") or 0)
    removed = qm.clear_upcoming(chat_id)
    return web.json_response({"ok": True, "removed": removed})


@routes.post("/remove")
async def remove(request: web.Request) -> web.Response:
    """Remove a single upcoming track by its 1-based position."""
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    data = await _body(request)
    chat_id = int(data.get("chat_id") or 0)
    index = int(data.get("index") or 0)
    track = qm.remove(chat_id, index)
    if not track:
        return web.json_response({"ok": False, "error": "bad_index"})
    return web.json_response({"ok": True, **_track_info(track)})


@routes.post("/import")
async def import_audio(request: web.Request) -> web.Response:
    """Bulk-import audio from a source channel into the archive storage channel.
    Runs in the background, slowly, and stops on the first FloodWait."""
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    if not _ready:
        return web.json_response({"ok": False, "error": "starting"})
    global _importing
    if _importing:
        return web.json_response({"ok": False, "error": "already_importing"})
    if not config.MUSIC_STORAGE_CHANNEL_ID:
        return web.json_response({"ok": False, "error": "no_storage_channel"})
    data = await _body(request)
    source = (data.get("source") or "").strip()
    limit = max(1, min(int(data.get("limit") or 50), IMPORT_MAX))
    notify_chat = data.get("notify_chat")
    if not source:
        return web.json_response({"ok": False, "error": "bad_request"}, status=400)
    _importing = True
    _spawn(_run_import(source, limit, config.MUSIC_STORAGE_CHANNEL_ID, notify_chat))
    return web.json_response({"ok": True, "started": True, "limit": limit})


@routes.post("/importstop")
async def import_stop(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    global _import_stop
    _import_stop = True
    return web.json_response({"ok": True, "importing": _importing})


async def _notify_import(notify_chat, text: str) -> None:
    """Send import progress to the bot, which relays it to the owner."""
    if not notify_chat or not config.BOT_CALLBACK_URL:
        return
    parts = urlsplit(config.BOT_CALLBACK_URL)
    url = f"{parts.scheme}://{parts.netloc}/import/progress"
    try:
        async with aiohttp.ClientSession() as s:
            await s.post(
                url,
                json={"chat_id": notify_chat, "text": text},
                headers={"X-Token": config.STREAMER_TOKEN},
                timeout=aiohttp.ClientTimeout(total=10),
            )
    except Exception as e:
        log.info("import notify failed: %s", e)


_AUDIO_EXT = (".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac", ".wma", ".alac", ".aif", ".aiff")


def _is_audio_msg(msg) -> bool:
    """Music channels often upload MP3s as documents, not native audio — treat
    an audio-mime / audio-extension document as a song too."""
    if getattr(msg, "audio", None):
        return True
    doc = getattr(msg, "document", None)
    if doc:
        mime = (getattr(doc, "mime_type", "") or "").lower()
        name = (getattr(doc, "file_name", "") or "").lower()
        if mime.startswith("audio/") or name.endswith(_AUDIO_EXT):
            return True
    return False


async def _run_import(source: str, limit: int, storage: int, notify_chat) -> None:
    global _importing, _import_stop
    copied = 0
    scanned = 0
    scan_cap = limit * 20  # don't crawl an entire huge channel
    try:
        try:
            await assistant.join_chat(source)
        except Exception as e:
            log.info("import join %s: %s", source, e)
        await _notify_import(notify_chat, f"📥 بدأ الاستيراد من {source} (حد {limit}).")
        seen = {"audio": 0, "document": 0, "video": 0, "voice": 0, "photo": 0, "other": 0}
        async for msg in assistant.get_chat_history(source):
            if _import_stop:
                await _notify_import(notify_chat, f"🛑 وقّفت الاستيراد عند {copied} أغنية.")
                return
            scanned += 1
            if scanned > scan_cap:
                break
            # Tally what we see so a "0 songs" result can explain itself.
            for kind in ("audio", "document", "video", "voice", "photo"):
                if getattr(msg, kind, None):
                    seen[kind] += 1
                    break
            else:
                seen["other"] += 1
            if not _is_audio_msg(msg):
                continue
            try:
                await msg.copy(storage)
                copied += 1
            except Exception as e:
                if type(e).__name__ == "FloodWait":
                    secs = getattr(e, "value", None) or getattr(e, "x", None) or 30
                    await _notify_import(notify_chat, f"⏸ FloodWait {secs}s — بوقف الاستيراد احتراماً له عند {copied}.")
                    return  # full stop on flood, per policy
                log.info("import copy failed: %s", e)
                continue
            if copied >= limit:
                break
            if copied % 25 == 0:
                await _notify_import(notify_chat, f"📥 استوردت {copied} أغنية…")
            await asyncio.sleep(IMPORT_MIN_DELAY + random.random() * 2)  # 3–5s
        if copied:
            tail = ""
        else:
            tail = (
                f" (فحصت {scanned} رسالة → صوت={seen['audio']}, ملفات={seen['document']}, "
                f"فيديو={seen['video']}, صوتيات={seen['voice']}, صور={seen['photo']}, غير ذلك={seen['other']})."
            )
        await _notify_import(notify_chat, f"✅ خلص الاستيراد: {copied} أغنية.{tail}")
    except Exception as e:
        log.warning("import error: %s", e)
        await _notify_import(notify_chat, f"⚠️ توقّف الاستيراد بخطأ عند {copied}: {e}")
    finally:
        _importing = False
        _import_stop = False


# Auto-advance: when a track ends, play the next queued one (or leave if empty).
# NOTE: pass an INSTANCE — stream_end() — not the class; the framework awaits it.
@calls.on_update(call_filters.stream_end())
async def _on_stream_end(_, update) -> None:
    chat_id = getattr(update, "chat_id", None)
    if chat_id is None:
        return
    nxt = qm.next_track(chat_id)
    if not nxt:
        try:
            await calls.leave_call(chat_id)
        except Exception:
            pass
        return
    try:
        await calls.play(chat_id, _audio(nxt["url"]))
        log.info("auto-advanced in %s → %s", chat_id, nxt.get("title"))
        await _notify_now_playing(chat_id, nxt)
    except Exception as e:
        log.warning("auto-advance failed in %s: %s", chat_id, e)


async def _notify_now_playing(chat_id: int, track: dict) -> None:
    """Tell the management bot which track just auto-started, so it posts the
    now-playing card. Best-effort — never breaks playback if the bot is down."""
    if not config.BOT_CALLBACK_URL:
        return
    payload = {
        "chat_id": chat_id,
        "title": track.get("title"),
        "uploader": track.get("uploader", ""),
        "duration": track.get("duration", 0),
        "thumb": track.get("thumb", ""),
    }
    try:
        async with aiohttp.ClientSession() as s:
            await s.post(
                config.BOT_CALLBACK_URL,
                json=payload,
                headers={"X-Token": config.STREAMER_TOKEN},
                timeout=aiohttp.ClientTimeout(total=10),
            )
    except Exception as e:
        log.info("now-playing notify failed for %s: %s", chat_id, e)


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

    # Wait a bit so any previous deployment fully shuts down before we connect
    # the assistant — avoids two instances briefly sharing the session on a
    # redeploy (Telegram kills that with AUTH_KEY_DUPLICATED).
    if config.START_DELAY > 0:
        log.info("waiting %ss before connecting the assistant (redeploy safety)…", config.START_DELAY)
        await asyncio.sleep(config.START_DELAY)

    # Connect the assistant + PyTgCalls (needed for actual playback). Do NOT
    # crash the whole service if this fails — keep serving so search still works
    # and the session can be fixed without the container crash-looping.
    global _ready, _assistant_id
    try:
        await assistant.start()
        await calls.start()
        me = await assistant.get_me()
        _assistant_id = me.id
        _ready = True
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
