/**
 * Parse a short human duration like "30m", "2h", "1d", "45s", "1w" into seconds.
 * Bare numbers are treated as minutes ("30" → 1800s). Returns null when the
 * input is missing or malformed. Capped at 365 days (Telegram's practical max).
 */
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

const MAX_SECONDS = 365 * 86400;

export function parseDuration(input: string | undefined): number | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  const m = /^(\d+)\s*(s|m|h|d|w|ث|د|س|ي|ا)?$/.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isInteger(value) || value <= 0) return null;
  // Arabic unit aliases → latin.
  const arabic: Record<string, string> = { 'ث': 's', 'د': 'm', 'س': 'h', 'ي': 'd', 'ا': 'w' };
  const unitRaw = m[2] ?? 'm';
  const unit = arabic[unitRaw] ?? unitRaw;
  const secs = value * (UNIT_SECONDS[unit] ?? 60);
  return Math.min(secs, MAX_SECONDS);
}

/** Human-readable Arabic label for a duration in seconds. */
export function formatDuration(secs: number): string {
  if (secs >= 86400) return `${Math.round(secs / 86400)} يوم`;
  if (secs >= 3600) return `${Math.round(secs / 3600)} ساعة`;
  if (secs >= 60) return `${Math.round(secs / 60)} دقيقة`;
  return `${secs} ثانية`;
}
