"""Per-chat playback queue + the currently-playing track."""
from collections import defaultdict, deque
from typing import Optional

# Upcoming tracks per chat.
_queues: dict[int, deque] = defaultdict(deque)
# Currently-playing track per chat.
_active: dict[int, dict] = {}


def enqueue(chat_id: int, track: dict) -> int:
    """Add a track to the end of the queue; return its position (1-based)."""
    _queues[chat_id].append(track)
    return len(_queues[chat_id])


def next_track(chat_id: int) -> Optional[dict]:
    """Pop and return the next queued track (and mark it active), or None."""
    q = _queues[chat_id]
    if q:
        track = q.popleft()
        _active[chat_id] = track
        return track
    _active.pop(chat_id, None)
    return None


def set_active(chat_id: int, track: dict) -> None:
    _active[chat_id] = track


def active(chat_id: int) -> Optional[dict]:
    return _active.get(chat_id)


def upcoming(chat_id: int) -> list[dict]:
    return list(_queues[chat_id])


def clear(chat_id: int) -> None:
    _queues[chat_id].clear()
    _active.pop(chat_id, None)
