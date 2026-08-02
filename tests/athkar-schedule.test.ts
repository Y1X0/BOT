import { describe, it, expect } from 'vitest';
import { slotForHour, slotTag, dailyAyahNumber } from '../src/plugins/islamic/schedule';
import { MORNING_ATHKAR, EVENING_ATHKAR } from '../src/plugins/islamic/data';

describe('athkar scheduling', () => {
  it('maps 7am to morning and 6pm to evening', () => {
    expect(slotForHour(7)).toBe('m');
    expect(slotForHour(18)).toBe('e');
  });
  it('returns null at other hours', () => {
    expect(slotForHour(6)).toBeNull();
    expect(slotForHour(8)).toBeNull();
    expect(slotForHour(0)).toBeNull();
  });
  it('slotTag combines day and slot and differs by slot/day', () => {
    const now = new Date('2026-08-02T04:00:00Z');
    expect(slotTag(now, 'm')).toBe('2026-08-02:m');
    expect(slotTag(now, 'e')).toBe('2026-08-02:e');
    expect(slotTag(new Date('2026-08-03T04:00:00Z'), 'm')).toBe('2026-08-03:m');
  });
});

describe('dailyAyahNumber', () => {
  it('is in the valid verse range 1..6236', () => {
    for (const d of ['2026-08-02', '2026-01-01', '2026-12-31']) {
      const n = dailyAyahNumber(new Date(`${d}T09:00:00Z`));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6236);
    }
  });
  it('is stable per day and varies across days', () => {
    const a = dailyAyahNumber(new Date('2026-08-02T09:00:00Z'));
    expect(dailyAyahNumber(new Date('2026-08-02T20:00:00Z'))).toBe(a);
    expect(dailyAyahNumber(new Date('2026-08-03T09:00:00Z'))).not.toBe(a);
  });
});

describe('athkar content', () => {
  it('has non-empty morning and evening sets', () => {
    expect(MORNING_ATHKAR.length).toBeGreaterThan(5);
    expect(EVENING_ATHKAR.length).toBeGreaterThan(5);
    expect(MORNING_ATHKAR.every((x) => x.trim().length > 0)).toBe(true);
    expect(EVENING_ATHKAR.every((x) => x.trim().length > 0)).toBe(true);
  });
});
