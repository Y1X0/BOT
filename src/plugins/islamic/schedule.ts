/** Pure scheduling helpers for automatic athkar and the daily ayah. */
import { hashStr, dayKey } from '../social/logic';

export type AthkarSlot = 'm' | 'e';

/** Which athkar slot (if any) fires at a given local hour. */
export function slotForHour(hour: number, morningHour = 7, eveningHour = 18): AthkarSlot | null {
  if (hour === morningHour) return 'm';
  if (hour === eveningHour) return 'e';
  return null;
}

/** De-dupe tag combining the day and slot, e.g. "2026-08-02:m". */
export function slotTag(now: Date, slot: AthkarSlot): string {
  return `${now.toISOString().slice(0, 10)}:${slot}`;
}

/** Deterministic verse number (1..6236) for a given day — same for all groups. */
export function dailyAyahNumber(now: Date): number {
  return (hashStr(`ayah:${dayKey(now)}`) % 6236) + 1;
}

// ---- Prayer notifications ----
export const PRAYERS: { key: string; ar: string }[] = [
  { key: 'Fajr', ar: 'الفجر' },
  { key: 'Dhuhr', ar: 'الظهر' },
  { key: 'Asr', ar: 'العصر' },
  { key: 'Maghrib', ar: 'المغرب' },
  { key: 'Isha', ar: 'العشاء' },
];

/** "HH:MM" (possibly with a suffix) → minutes since midnight, or null. */
export function parseHHMM(s: string | undefined): number | null {
  const m = s?.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Which prayer (if any) falls exactly at `currentMinutes`. */
export function matchPrayer(currentMinutes: number, timings: Record<string, string>): { key: string; ar: string } | null {
  for (const p of PRAYERS) {
    if (parseHHMM(timings[p.key]) === currentMinutes) return p;
  }
  return null;
}
