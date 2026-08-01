/**
 * Shared in-memory state for the whisper flow. Kept in its own module so the
 * aliases middleware can check `isAwaitingWhisper` and avoid rewriting a
 * whisper's secret text (typed in DM) into a command.
 */
export interface Whisper {
  senderId: number;
  targetId: number;
  targetUsername?: string;
  targetName: string;
  text: string;
}

export interface PendingWhisper {
  senderId: number;
  targetId: number;
  targetUsername?: string;
  targetName: string;
  chatId: number;
  promptMsgId: number;
}

/** Revealable whispers, keyed by id (used in the reveal button). */
export const whispers = new Map<string, Whisper>();
/** Whispers awaiting their secret, keyed by a deep-link token. */
export const pendingTokens = new Map<string, PendingWhisper>();
/** Users currently typing a secret in DM → their token. */
export const dmPending = new Map<number, string>();

const MAX = 5000;
let counter = 0;

function nextId(seed: number): string {
  return `${seed.toString(36)}${(counter++).toString(36)}`;
}

export function storeWhisper(w: Whisper): string {
  const id = nextId(w.senderId);
  whispers.set(id, w);
  if (whispers.size > MAX) {
    const oldest = whispers.keys().next().value;
    if (oldest) whispers.delete(oldest);
  }
  return id;
}

export function makeToken(senderId: number): string {
  return nextId(senderId);
}

export function isAwaitingWhisper(userId: number): boolean {
  return dmPending.has(userId);
}
