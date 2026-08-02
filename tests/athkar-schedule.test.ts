import { describe, it, expect } from 'vitest';
import { slotForHour, slotTag } from '../src/plugins/islamic/schedule';
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

describe('athkar content', () => {
  it('has non-empty morning and evening sets', () => {
    expect(MORNING_ATHKAR.length).toBeGreaterThan(5);
    expect(EVENING_ATHKAR.length).toBeGreaterThan(5);
    expect(MORNING_ATHKAR.every((x) => x.trim().length > 0)).toBe(true);
    expect(EVENING_ATHKAR.every((x) => x.trim().length > 0)).toBe(true);
  });
});
