"""
Generate the assistant account's Pyrogram STRING SESSION.

Run this ONCE, locally, logged in as the ASSISTANT account (the extra phone
number that will join voice chats — NOT your main account, and NOT the bot):

    python gen_session.py

It asks for API_ID / API_HASH (from my.telegram.org), the assistant's phone
number, the login code Telegram sends, and 2FA password if enabled. It prints a
SESSION_STRING — copy it into your .env as SESSION_STRING.
"""
import asyncio

from pyrogram import Client


async def main() -> None:
    print("=== توليد جلسة الحساب المساعد (Assistant) ===")
    api_id = int(input("API_ID: ").strip())
    api_hash = input("API_HASH: ").strip()
    async with Client("gen", api_id=api_id, api_hash=api_hash, in_memory=True) as app:
        s = await app.export_session_string()
        print("\n✅ SESSION_STRING (انسخه كامل إلى .env):\n")
        print(s)
        print("\n⚠️ لا تشاركه مع أحد — يعطي وصولاً كاملاً لحساب المساعد.")


if __name__ == "__main__":
    asyncio.run(main())
