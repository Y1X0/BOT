"""
Voice-chat music bot (تشغيل الأغاني على الكول).

A command-facing bot + an assistant user account that streams audio into the
group's voice chat via WebRTC (py-tgcalls). Commands are Arabic-first.

Requirements to RUN (see README.md):
  API_ID, API_HASH, BOT_TOKEN (separate bot), SESSION_STRING (assistant account).
The assistant must be an admin in the group with the "manage voice chats" right.
"""
import asyncio
import logging

from pyrogram import filters, idle
from pyrogram.types import Message
from pytgcalls import PyTgCalls
from pytgcalls import filters as call_filters
from pytgcalls.exceptions import NoActiveGroupCall
from pytgcalls.types import MediaStream, Update

import config
import queue_manager as qm
from call_control import end_call, start_call
from clients import assistant, bot, calls
from youtube import fmt_duration, search

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("music-bot")

GROUP = filters.group


def cmd(words: list[str]):
    return filters.command(words, prefixes=config.PREFIXES) & GROUP


def _audio_stream(url: str) -> MediaStream:
    # Audio-only: ignore any video track so we never need a video source.
    return MediaStream(url, video_flags=MediaStream.Flags.IGNORE)


async def _play_now(chat_id: int, track: dict) -> None:
    """Stream a track, opening the voice chat first if none is active."""
    try:
        await calls.play(chat_id, _audio_stream(track["url"]))
    except NoActiveGroupCall:
        await start_call(assistant, chat_id)  # open the VC, then retry
        await calls.play(chat_id, _audio_stream(track["url"]))


def _track_line(track: dict, prefix: str) -> str:
    dur = fmt_duration(track.get("duration", 0))
    return f"{prefix} <b>{track['title']}</b>\n⏱ {dur}"


# ── Help ────────────────────────────────────────────────────────────────────
@bot.on_message(cmd(["start", "help", "مساعدة", "الاوامر"]))
async def help_cmd(_, m: Message):
    await m.reply(
        "🎧 <b>بوت الكول</b>\n\n"
        "• <code>افتح كول</code> — يفتح مكالمة جماعية\n"
        "• <code>تشغيل &lt;اسم الأغنية&gt;</code> — يشغّل أغنية بالكول (أو بالرد على رسالة)\n"
        "• <code>تخطي</code> — الأغنية التالية\n"
        "• <code>ايقاف</code> / <code>كمل</code> — إيقاف مؤقت / استئناف\n"
        "• <code>الطابور</code> — قائمة الانتظار\n"
        "• <code>سكر كول</code> — ينهي المكالمة\n\n"
        "⚠️ لازم الحساب المساعد يكون <b>أدمن</b> بالقروب مع صلاحية إدارة المكالمات.",
        disable_web_page_preview=True,
    )


# ── Open / close the voice chat ───────────────────────────────────────────────
@bot.on_message(filters.regex(r"^(افتح|فتح|افتحلي)\s*(كول|مكالمة|فويس)") & GROUP)
async def open_vc(_, m: Message):
    try:
        await start_call(assistant, m.chat.id)
        await m.reply("✅ فتحت الكول. اكتب: تشغيل اسم الأغنية")
    except Exception as e:  # already open, or missing rights
        txt = str(e)
        if "GROUPCALL_INVALID" in txt or "already" in txt.lower():
            await m.reply("ℹ️ الكول مفتوح أصلاً.")
        elif "CHAT_ADMIN_REQUIRED" in txt or "RIGHT" in txt.upper():
            await m.reply("⛔️ الحساب المساعد لازم يكون أدمن مع صلاحية إدارة المكالمات.")
        else:
            await m.reply(f"ما قدرت أفتح الكول: {txt}")


@bot.on_message(filters.regex(r"^(سكر|اغلق|انهاء|انهي)\s*(الكول|كول|المكالمة)") & GROUP)
async def close_vc(_, m: Message):
    chat_id = m.chat.id
    qm.clear(chat_id)
    try:
        await calls.leave_call(chat_id)
    except Exception:
        pass
    try:
        ended = await end_call(assistant, chat_id)
    except Exception as e:
        return await m.reply(f"ما قدرت أسكّر الكول: {e}")
    await m.reply("👋 سكّرت الكول." if ended else "ℹ️ ما في كول مفتوح.")


# ── Play / queue ──────────────────────────────────────────────────────────────
@bot.on_message(cmd(["تشغيل", "شغل", "بلاي", "play", "vplay", "غني"]))
async def play_cmd(_, m: Message):
    parts = m.text.split(None, 1)
    query = None
    if len(parts) > 1:
        query = parts[1].strip()
    elif m.reply_to_message and (m.reply_to_message.text or m.reply_to_message.caption):
        query = (m.reply_to_message.text or m.reply_to_message.caption).strip()
    if not query:
        return await m.reply("🎵 اكتب اسم الأغنية: <code>تشغيل نانسي عجرم</code>")

    status = await m.reply("🔎 عم دوّر…")
    track = await search(query)
    if not track or not track.get("url"):
        return await status.edit("❌ ما لقيت الأغنية. جرّب اسم تاني.")

    chat_id = m.chat.id
    # Something already playing → enqueue.
    if qm.active(chat_id):
        pos = qm.enqueue(chat_id, track)
        return await status.edit(_track_line(track, "➕ أضيفت للطابور") + f"\n🔢 الترتيب: {pos}")

    qm.set_active(chat_id, track)
    try:
        await _play_now(chat_id, track)
    except Exception as e:
        qm.clear(chat_id)
        txt = str(e)
        if "CHAT_ADMIN_REQUIRED" in txt or "RIGHT" in txt.upper():
            return await status.edit("⛔️ الحساب المساعد لازم يكون أدمن مع صلاحية إدارة المكالمات.")
        return await status.edit(f"ما قدرت أشغّل: {txt}")
    await status.edit(_track_line(track, "▶️ عم يشغّل الآن"))


@bot.on_message(cmd(["تخطي", "تخط", "التالي", "سكيب", "skip", "next"]))
async def skip_cmd(_, m: Message):
    chat_id = m.chat.id
    nxt = qm.next_track(chat_id)
    if not nxt:
        qm.clear(chat_id)
        try:
            await calls.leave_call(chat_id)
        except Exception:
            pass
        return await m.reply("⏭ خلص الطابور — طلعت من الكول.")
    try:
        await calls.play(chat_id, _audio_stream(nxt["url"]))
    except Exception as e:
        return await m.reply(f"ما قدرت أتخطى: {e}")
    await m.reply(_track_line(nxt, "⏭ التالي"))


@bot.on_message(cmd(["ايقاف", "وقف", "pause"]))
async def pause_cmd(_, m: Message):
    try:
        await calls.pause(m.chat.id)
        await m.reply("⏸ وقّفت الأغنية مؤقتاً. اكتب: كمل")
    except Exception:
        await m.reply("ما في شي عم يشتغل.")


@bot.on_message(cmd(["كمل", "استكمال", "استئناف", "resume"]))
async def resume_cmd(_, m: Message):
    try:
        await calls.resume(m.chat.id)
        await m.reply("▶️ كمّلت.")
    except Exception:
        await m.reply("ما في شي موقوف.")


@bot.on_message(cmd(["الطابور", "القائمة", "قائمة", "queue"]))
async def queue_cmd(_, m: Message):
    chat_id = m.chat.id
    cur = qm.active(chat_id)
    if not cur:
        return await m.reply("📭 ما في شي عم يشتغل.")
    lines = [_track_line(cur, "▶️ الآن")]
    up = qm.upcoming(chat_id)
    if up:
        lines.append("\n📜 <b>بالطابور:</b>")
        for i, tr in enumerate(up[:10], 1):
            lines.append(f"{i}. {tr['title']} ({fmt_duration(tr.get('duration', 0))})")
        if len(up) > 10:
            lines.append(f"… و{len(up) - 10} غيرها")
    await m.reply("\n".join(lines), disable_web_page_preview=True)


# ── Auto-advance when a track ends ────────────────────────────────────────────
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
        await calls.play(chat_id, _audio_stream(nxt["url"]))
        await bot.send_message(chat_id, _track_line(nxt, "▶️ التالي"), disable_web_page_preview=True)
    except Exception as e:
        log.warning("auto-advance failed in %s: %s", chat_id, e)


async def main() -> None:
    config.validate()
    await bot.start()
    await assistant.start()
    await calls.start()
    me = await bot.get_me()
    log.info("Music bot @%s is up. Assistant + PyTgCalls started.", me.username)
    await idle()
    await bot.stop()
    await assistant.stop()


if __name__ == "__main__":
    asyncio.run(main())
