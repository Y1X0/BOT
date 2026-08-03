/** Pending anonymous-message composition: opener userId → target userId. */
export const msPending = new Map<number, number>();

/** Maps a delivered message (`${ownerId}:${msgId}`) → the anonymous sender's id,
 *  so the owner can just reply to it natively. */
export const msgToSender = new Map<string, number>();

/** ownerId → set of sender ids they've blocked. */
export const blocked = new Map<number, Set<number>>();

export function isAwaitingMusaraha(userId: number): boolean {
  return msPending.has(userId);
}

export function isMusarahaReply(ownerId: number, repliedMsgId: number): boolean {
  return msgToSender.has(`${ownerId}:${repliedMsgId}`);
}

export function isBlocked(ownerId: number, senderId: number): boolean {
  return blocked.get(ownerId)?.has(senderId) ?? false;
}

export function blockSender(ownerId: number, senderId: number): void {
  const s = blocked.get(ownerId) ?? new Set<number>();
  s.add(senderId);
  blocked.set(ownerId, s);
}
