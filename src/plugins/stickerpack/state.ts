/** Live pack-creation state (short-lived). */
export const packState = new Map<number, { step: 'title' | 'image'; title?: string }>();

export function isAwaitingPackTitle(userId: number): boolean {
  return packState.get(userId)?.step === 'title';
}
