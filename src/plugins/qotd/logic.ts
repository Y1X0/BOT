import { hashStr, dayKey } from '../social/logic';

/** Deterministic question index for a chat on a given day. */
export function questionIndex(chatId: string, now: Date, len: number): number {
  return len > 0 ? hashStr(`qotd:${chatId}:${dayKey(now)}`) % len : 0;
}

/** Should the auto-post fire? Target hour (UTC) and not already posted today. */
export function isQotdDue(now: Date, lastPosted: Date | null, hour = 10): boolean {
  if (now.getUTCHours() !== hour) return false;
  if (!lastPosted) return true;
  return dayKey(lastPosted) !== dayKey(now);
}
