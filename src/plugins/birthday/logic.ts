/** Pure helpers for birthdays: parsing and date maths (testable, no DB). */

export interface BirthDate {
  day: number;
  month: number;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Parse "DD-MM" / "DD/MM" / "DD MM" into a validated {day, month}, or null. */
export function parseBirthday(input: string): BirthDate | null {
  const m = input.trim().match(/^(\d{1,2})\s*[-/.\s]\s*(\d{1,2})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return { day, month };
}

export function isBirthdayToday(day: number, month: number, now: Date): boolean {
  return now.getUTCDate() === day && now.getUTCMonth() + 1 === month;
}

/** Days until the next occurrence of day/month (0 = today), for sorting. */
export function daysUntil(day: number, month: number, now: Date): number {
  const y = now.getUTCFullYear();
  const todayUtc = Date.UTC(y, now.getUTCMonth(), now.getUTCDate());
  let next = Date.UTC(y, month - 1, day);
  if (next < todayUtc) next = Date.UTC(y + 1, month - 1, day);
  return Math.round((next - todayUtc) / 86_400_000);
}
