"""
Start / end a group voice chat via the assistant account (raw MTProto).

The Bot API has no voice-chat methods, so these go through the assistant user
account. The assistant must be an admin with the "manage voice chats" right.
"""
import random
from typing import Optional

from pyrogram import Client
from pyrogram.raw.functions.channels import GetFullChannel
from pyrogram.raw.functions.messages import GetFullChat
from pyrogram.raw.functions.phone import CreateGroupCall, DiscardGroupCall
from pyrogram.raw.types import InputChannel, InputGroupCall, InputPeerChannel


async def _active_call(client: Client, chat_id: int) -> Optional[InputGroupCall]:
    """Return the chat's active InputGroupCall, or None if no VC is open."""
    peer = await client.resolve_peer(chat_id)
    if isinstance(peer, InputPeerChannel):
        full = await client.invoke(
            GetFullChannel(channel=InputChannel(channel_id=peer.channel_id, access_hash=peer.access_hash))
        )
    else:
        full = await client.invoke(GetFullChat(chat_id=peer.chat_id))
    return getattr(full.full_chat, "call", None)


async def start_call(client: Client, chat_id: int) -> None:
    """Open a voice chat. Raises if one is already open or on missing rights."""
    peer = await client.resolve_peer(chat_id)
    await client.invoke(
        CreateGroupCall(peer=peer, random_id=random.randint(10_000, 2_000_000_000))
    )


async def end_call(client: Client, chat_id: int) -> bool:
    """Close the active voice chat. Returns False if there was none."""
    call = await _active_call(client, chat_id)
    if not call:
        return False
    await client.invoke(DiscardGroupCall(call=call))
    return True


async def has_active_call(client: Client, chat_id: int) -> bool:
    try:
        return await _active_call(client, chat_id) is not None
    except Exception:
        return False
