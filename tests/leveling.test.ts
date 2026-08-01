import { describe, it, expect } from 'vitest';
import { xpForLevel, levelFromXp } from '../src/services/member.service';

describe('XP / leveling', () => {
  it('level 0 requires the base threshold', () => {
    expect(xpForLevel(0)).toBe(100);
  });

  it('thresholds increase monotonically', () => {
    for (let l = 0; l < 20; l++) {
      expect(xpForLevel(l + 1)).toBeGreaterThan(xpForLevel(l));
    }
  });

  it('new member with 0 XP is level 0', () => {
    expect(levelFromXp(0)).toBe(0);
  });

  it('crossing a threshold increases the level', () => {
    const threshold = xpForLevel(0); // 100
    expect(levelFromXp(threshold - 1)).toBe(0);
    expect(levelFromXp(threshold)).toBe(1);
  });

  it('level is consistent with its own threshold', () => {
    const xp = 5000;
    const level = levelFromXp(xp);
    expect(xp).toBeGreaterThanOrEqual(xpForLevel(level - 1));
    expect(xp).toBeLessThan(xpForLevel(level));
  });
});
