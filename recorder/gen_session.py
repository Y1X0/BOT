"""
Generate a Pyrogram STRING SESSION for YOUR Telegram account — run this ONCE on
your own device (phone via Termux, or a PC). It logs you in (phone number + the
code Telegram sends) and prints a long SESSION_STRING. Copy that string into the
GitHub repo secret named SESSION_STRING.

Use YOUR account (the Premium one) so uploads can reach up to 4GB.

    pip install kurigram tgcrypto
    python gen_session.py
"""
import asyncio
import os

from pyrogram import Client


async def main() -> None:
    api_id = int(os.environ.get("API_ID") or input("API_ID: ").strip())
    api_hash = os.environ.get("API_HASH") or input("API_HASH: ").strip()
    async with Client("gen", api_id=api_id, api_hash=api_hash, in_memory=True) as app:
        s = await app.export_session_string()
        print("\n================  SESSION_STRING  ================\n")
        print(s)
        print("\n=================================================")
        print("انسخ السطر أعلاه كاملًا وحطّه بـ GitHub → Settings → Secrets → SESSION_STRING")


asyncio.run(main())
