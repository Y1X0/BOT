/**
 * Short-lived cache of a rendered "id" card's Telegram file_id, keyed by
 * chat+user. A repeat «ايدي» within the TTL is re-sent by file_id instantly —
 * no browser render, no upload. Stats can be up to TTL seconds stale, which is
 * fine for a profile card. Random-theme cards are simply not cached by the
 * caller so they keep varying.
 */
interface Entry {
  fileId: string;
  kind: 'photo' | 'animation';
  at: number;
}

const store = new Map<string, Entry>();
const TTL_MS = 150_000; // 2.5 minutes
const MAX = 1000;

const keyFor = (chatId: number | bigint, userId: number | bigint): string => `${chatId}:${userId}`;

export function getCard(chatId: number | bigint, userId: number | bigint): Entry | null {
  const e = store.get(keyFor(chatId, userId));
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(keyFor(chatId, userId));
    return null;
  }
  return e;
}

export function setCard(chatId: number | bigint, userId: number | bigint, fileId: string, kind: 'photo' | 'animation'): void {
  store.set(keyFor(chatId, userId), { fileId, kind, at: Date.now() });
  if (store.size > MAX) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
}

export function clearCard(chatId: number | bigint, userId: number | bigint): void {
  store.delete(keyFor(chatId, userId));
}

/**
 * Cache of a downloaded avatar as a base64 data-URI, keyed by Telegram file_id.
 * A file_id changes whenever the user changes their photo, so a hit is always
 * the current avatar — safe to keep longer than the card cache. This skips the
 * getFileLink + download round-trips when re-rendering (e.g. random theme, or
 * after the card cache expires).
 */
const avatars = new Map<string, { uri: string; at: number }>();
const AVATAR_TTL_MS = 600_000; // 10 minutes
const AVATAR_MAX = 500;

export function getAvatar(fileId: string): string | null {
  const e = avatars.get(fileId);
  if (!e) return null;
  if (Date.now() - e.at > AVATAR_TTL_MS) {
    avatars.delete(fileId);
    return null;
  }
  return e.uri;
}

export function setAvatar(fileId: string, uri: string): void {
  avatars.set(fileId, { uri, at: Date.now() });
  if (avatars.size > AVATAR_MAX) {
    const oldest = avatars.keys().next().value;
    if (oldest) avatars.delete(oldest);
  }
}
