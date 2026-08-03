/** Live composition state only (short-lived; persistence lives in the DB). */
export const msPending = new Map<number, number>(); // opener userId → target userId

export function isAwaitingMusaraha(userId: number): boolean {
  return msPending.has(userId);
}
