/** Pure helpers for the support-ticket feature. */

/** Split "<id> <text>" into its parts, or null if malformed. */
export function parseIdAndText(raw: string): { id: number; text: string } | null {
  const m = raw.trim().match(/^(\d+)\s+([\s\S]+)$/);
  if (!m) return null;
  return { id: Number(m[1]), text: m[2].trim() };
}

/** Parse a leading numeric id (for /ticketview 5, /ticketclose 5). */
export function parseId(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Truncate long text for list previews. */
export function snippet(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
