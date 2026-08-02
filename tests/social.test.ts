import { describe, it, expect } from 'vitest';
import { hashStr, dailyIndex, dayKey } from '../src/plugins/social/logic';

describe('social daily picker', () => {
  it('hashStr is deterministic and unsigned', () => {
    expect(hashStr('abc')).toBe(hashStr('abc'));
    expect(hashStr('abc')).toBeGreaterThanOrEqual(0);
    expect(hashStr('abc')).not.toBe(hashStr('abd'));
  });

  it('dailyIndex stays within range and is stable for the same seed', () => {
    for (let len = 1; len <= 10; len++) {
      const i = dailyIndex('user:1:2026-08-02', len);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(len);
    }
    expect(dailyIndex('seed', 10)).toBe(dailyIndex('seed', 10));
  });

  it('different seeds usually map differently', () => {
    const a = dailyIndex('user:1:2026-08-02', 10);
    const b = dailyIndex('user:2:2026-08-02', 10);
    const c = dailyIndex('user:1:2026-08-03', 10);
    // At least one of the two variations differs from a.
    expect(a !== b || a !== c).toBe(true);
  });

  it('dayKey returns an ISO date', () => {
    expect(dayKey(new Date('2026-08-02T15:30:00Z'))).toBe('2026-08-02');
  });

  it('dailyIndex handles empty arrays', () => {
    expect(dailyIndex('x', 0)).toBe(0);
  });
});
