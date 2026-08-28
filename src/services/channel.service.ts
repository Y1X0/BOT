import { getGlobal, setGlobal } from './global.service';

/**
 * Per-channel auto-reaction toggle. Channels aren't groups (no ChatSettings
 * row is bootstrapped for them), so this keeps the small amount of channel
 * state in one bot-wide GlobalConfig key: the list of channel ids where the
 * bot auto-reacts to new posts. Default OFF (empty) — an admin turns it on by
 * posting «تفاعل» in the channel, so the bot never reacts on channels the
 * owner didn't opt in (e.g. the music storage channel).
 */
const KEY = 'channelReact';

let reactOn = new Set<number>();
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  await refreshChannelReact();
}

/** Reload the enabled-channels set from the DB (called at startup + on writes). */
export async function refreshChannelReact(): Promise<void> {
  const raw = await getGlobal(KEY);
  const next = new Set<number>();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const n of arr) if (typeof n === 'number') next.add(n);
    } catch {
      /* ignore malformed */
    }
  }
  reactOn = next;
  loaded = true;
}

/** True when auto-reactions are enabled for this channel. */
export async function isChannelReactOn(channelId: number): Promise<boolean> {
  await ensureLoaded();
  return reactOn.has(channelId);
}

/** Enable/disable auto-reactions for a channel (persisted). */
export async function setChannelReact(channelId: number, on: boolean): Promise<void> {
  await ensureLoaded();
  if (on) reactOn.add(channelId);
  else reactOn.delete(channelId);
  await setGlobal(KEY, JSON.stringify([...reactOn]));
}
