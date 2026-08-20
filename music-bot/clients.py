"""The assistant user client + PyTgCalls instance (no bot token here)."""
from pyrogram import Client
from pytgcalls import PyTgCalls

import config

# The assistant USER account that joins the voice chat and streams audio.
assistant = Client(
    "assistant",
    api_id=config.API_ID,
    api_hash=config.API_HASH,
    session_string=config.SESSION_STRING,
    in_memory=True,
)

# WebRTC bridge that pushes audio into the group call through the assistant.
calls = PyTgCalls(assistant)
