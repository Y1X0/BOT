/** Users awaiting a caption for a sticker: `${chatId}:${userId}` → source fileId. */
export const pendingText = new Map<string, string>();

export function isAwaitingStickerText(chatId: number, userId: number): boolean {
  return pendingText.has(`${chatId}:${userId}`);
}
