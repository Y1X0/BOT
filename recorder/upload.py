"""
Upload the downloaded video(s) in ./out to Telegram using a USER account
(Pyrogram/kurigram) — a user account can send up to 2GB (4GB with Premium),
unlike a bot (50MB). Reads credentials from env (GitHub Actions secrets):

  API_ID, API_HASH   — from https://my.telegram.org
  SESSION_STRING     — a Pyrogram string session for YOUR (Premium) account
  TARGET             — optional; a chat id / @username / "me" (default: me =
                       Saved Messages)
"""
import asyncio
import glob
import os

from pyrogram import Client


async def main() -> None:
    api_id = int(os.environ["API_ID"])
    api_hash = os.environ["API_HASH"]
    session = os.environ["SESSION_STRING"]
    raw = (os.environ.get("TARGET") or "me").strip()
    target = int(raw) if raw.lstrip("-").isdigit() else raw

    files = sorted(f for f in glob.glob("out/*") if os.path.isfile(f))
    if not files:
        print("❌ لا يوجد ملف للرفع (فشل التنزيل؟)")
        raise SystemExit(1)

    app = Client("uploader", api_id=api_id, api_hash=api_hash, session_string=session, in_memory=True)
    await app.start()
    me = await app.get_me()
    print(f"✅ دخلت كـ: {me.first_name} (premium={getattr(me, 'is_premium', False)})")

    last = {"pct": -1}

    def progress(current: int, total: int) -> None:
        pct = int(current * 100 / total) if total else 0
        if pct != last["pct"] and pct % 5 == 0:
            last["pct"] = pct
            print(f"   ⬆️ {pct}%")

    for f in files:
        gb = os.path.getsize(f) / 1e9
        print(f"⬆️ رفع {os.path.basename(f)} ({gb:.2f} GB) → {target}")
        last["pct"] = -1
        await app.send_document(
            target, f, caption=os.path.basename(f), force_document=True, progress=progress
        )
        print("✅ تم الإرسال")

    await app.stop()
    print("🎉 خلص — شوف رسائلك المحفوظة بتيليجرام.")


asyncio.run(main())
