/** Pure helper: build a valid Telegram sticker-set name.
 *  Rules: [A-Za-z0-9_], begins with a letter, ends with "_by_<bot_username>",
 *  no consecutive underscores, ≤64 chars. */
export function packName(userId: number | bigint, botUsername: string, rand: number): string {
  return `u${userId}_${rand}_by_${botUsername}`;
}
