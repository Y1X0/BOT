/** Pending anonymous-message composition: opener userId → target userId. */
export const msPending = new Map<number, number>();

export function isAwaitingMusaraha(userId: number): boolean {
  return msPending.has(userId);
}
