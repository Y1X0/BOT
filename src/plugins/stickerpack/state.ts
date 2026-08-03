import type { PackKind } from '../../services/stickerpack.service';

/** Live pack-creation state (short-lived). */
export const packState = new Map<number, { step: 'title' | 'image'; title?: string; kind: PackKind }>();

export function isAwaitingPackTitle(userId: number): boolean {
  return packState.get(userId)?.step === 'title';
}
