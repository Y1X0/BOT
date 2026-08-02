/** Pure helpers for the social plugin: a stable per-day picker. */

/** djb2 string hash → unsigned 32-bit. */
export function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic index into an array of `len`, stable for a given seed. */
export function dailyIndex(seed: string, len: number): number {
  return len > 0 ? hashStr(seed) % len : 0;
}

/** UTC day string, e.g. "2026-08-02". */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
