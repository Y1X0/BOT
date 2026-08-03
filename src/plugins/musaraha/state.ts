/** Pending anonymous-message composition: opener userId → target userId. */
export const msPending = new Map<number, number>();

/** Owner composing a (named) reply → the anonymous sender's userId to reply to. */
export const msReplyPending = new Map<number, number>();

/** Reply-button token → who to reply to and who owns the link (may reply). */
export const replyRoutes = new Map<string, { senderId: number; ownerId: number }>();

let counter = 0;
export function makeReplyToken(): string {
  return `r${++counter}`;
}

export function isAwaitingMusaraha(userId: number): boolean {
  return msPending.has(userId) || msReplyPending.has(userId);
}
