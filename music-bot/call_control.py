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


class NoAccess(Exception):
    """The assistant can't see the chat — it isn't a member, or lost access.

    Distinct from "call is closed" so callers can tell the user to add the
    assistant (via /vcjoin) instead of the misleading "the call is closed".
    """


def _is_no_access(e: Exception) -> bool:
    name = type(e).__name__
    return name in ("PeerIdInvalid", "ChannelInvalid", "ChannelPrivate", "ChatIdInvalid") \
        or "PEER_ID_INVALID" in str(e)


async def call_is_open(client: Client, chat_id: int) -> bool:
    """True if a voice chat is open, False if closed.

    Raises NoAccess if the assistant isn't a member / can't resolve the peer.
    Any other unexpected error is treated as "closed" (the safe default — it
    won't trigger call churn).
    """
    try:
        return await _active_call(client, chat_id) is not None
    except Exception as e:
        if _is_no_access(e):
            raise NoAccess() from e
        return False
