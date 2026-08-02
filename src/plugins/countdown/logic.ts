/** Pure date helpers for the countdown feature (UTC-based). */

/** Parse "YYYY-MM-DD" or "DD-MM-YYYY" (also / separators) → UTC midnight, or null. */
export function parseDate(input: string): Date | null {
  const s = input.trim();
  let y: number, mo: number, d: number;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    d = +m[1]; mo = +m[2]; y = +m[3];
  } else {
    return null;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Reject overflow (e.g. 31 Feb rolls over).
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Whole days from now (UTC midnight) to target (UTC midnight). 0 = today. */
export function daysRemaining(target: Date, now: Date): number {
  const t = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((t - n) / 86_400_000);
}

export function countdownLabel(days: number): string {
  if (days === 0) return '🎉 اليوم!';
  if (days === 1) return '⏳ غداً!';
  if (days < 0) return '✅ انتهى';
  return `⏳ باقي ${days} يوم`;
}
