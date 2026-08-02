/** Pure helper for giveaways: pick a random winner. */

/** Return a random element (rand injectable for tests), or null if empty. */
export function pickWinner<T>(items: T[], rand: () => number): T | null {
  if (!items.length) return null;
  return items[Math.floor(rand() * items.length)];
}
