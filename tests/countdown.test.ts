import { describe, it, expect } from 'vitest';
import { parseDate, daysRemaining, countdownLabel } from '../src/plugins/countdown/logic';

describe('parseDate', () => {
  it('parses YYYY-MM-DD and DD-MM-YYYY', () => {
    expect(parseDate('2026-12-31')?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(parseDate('31-12-2026')?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(parseDate('05/08/2026')?.toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });
  it('rejects invalid dates', () => {
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('2026-02-31')).toBeNull();
    expect(parseDate('hello')).toBeNull();
  });
});

describe('daysRemaining', () => {
  const now = new Date('2026-08-02T15:00:00Z');
  it('is 0 on the same day regardless of time', () => {
    expect(daysRemaining(new Date('2026-08-02T00:00:00Z'), now)).toBe(0);
  });
  it('counts forward and backward', () => {
    expect(daysRemaining(new Date('2026-08-05T00:00:00Z'), now)).toBe(3);
    expect(daysRemaining(new Date('2026-08-01T00:00:00Z'), now)).toBe(-1);
  });
});

describe('countdownLabel', () => {
  it('labels today, tomorrow, future, past', () => {
    expect(countdownLabel(0)).toContain('اليوم');
    expect(countdownLabel(1)).toContain('غد');
    expect(countdownLabel(5)).toContain('5');
    expect(countdownLabel(-2)).toContain('انتهى');
  });
});
