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
