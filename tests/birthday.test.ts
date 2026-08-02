import { describe, it, expect } from 'vitest';
import { parseBirthday, isBirthdayToday, daysUntil } from '../src/plugins/birthday/logic';

describe('parseBirthday', () => {
  it('accepts DD-MM, DD/MM, DD MM', () => {
    expect(parseBirthday('05-08')).toEqual({ day: 5, month: 8 });
    expect(parseBirthday('5/8')).toEqual({ day: 5, month: 8 });
    expect(parseBirthday('05 08')).toEqual({ day: 5, month: 8 });
  });
  it('rejects invalid days/months', () => {
    expect(parseBirthday('32-01')).toBeNull();
    expect(parseBirthday('10-13')).toBeNull();
    expect(parseBirthday('00-05')).toBeNull();
    expect(parseBirthday('hello')).toBeNull();
  });
  it('respects days-per-month (Feb 30 invalid)', () => {
    expect(parseBirthday('30-02')).toBeNull();
    expect(parseBirthday('29-02')).toEqual({ day: 29, month: 2 });
  });
});

describe('isBirthdayToday', () => {
  it('matches the UTC day/month', () => {
    const now = new Date('2026-08-05T09:00:00Z');
    expect(isBirthdayToday(5, 8, now)).toBe(true);
    expect(isBirthdayToday(6, 8, now)).toBe(false);
  });
});

describe('daysUntil', () => {
  it('returns 0 on the day', () => {
    expect(daysUntil(5, 8, new Date('2026-08-05T00:00:00Z'))).toBe(0);
  });
  it('counts forward and wraps to next year', () => {
    expect(daysUntil(6, 8, new Date('2026-08-05T00:00:00Z'))).toBe(1);
    expect(daysUntil(1, 1, new Date('2026-12-31T00:00:00Z'))).toBe(1);
  });
});
