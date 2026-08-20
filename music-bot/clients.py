"""Shared Pyrogram clients + PyTgCalls instance."""
from pyrogram import Client
from pytgcalls import PyTgCalls

import config

# The command-facing bot (users talk to this).
bot = Client(
    "music_bot",
    api_id=config.API_ID,
    api_hash=config.API_HASH,
    bot_token=config.BOT_TOKEN,
    in_memory=True,
)

# The assistant USER account that actually joins the voice chat and streams.
assistant = Client(
    "assistant",
    api_id=config.API_ID,
    api_hash=config.API_HASH,
    session_string=config.SESSION_STRING,
    in_memory=True,
)

# WebRTC bridge that pushes audio into the group call through the assistant.
calls = PyTgCalls(assistant)
