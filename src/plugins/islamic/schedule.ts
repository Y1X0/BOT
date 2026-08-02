/** Pure scheduling helpers for automatic athkar. */

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
