import { describe, it, expect } from 'vitest';
import {
  decay,
  addPetXp,
  xpForLevel,
  mood,
  bar,
  HUNGER_DECAY_PER_HOUR,
} from '../src/services/pet-logic';

describe('decay', () => {
  it('reduces the stat by the hourly rate', () => {
    expect(decay(100, HUNGER_DECAY_PER_HOUR, 5)).toBe(100 - 5 * HUNGER_DECAY_PER_HOUR);
  });
  it('never drops below 0 or above 100', () => {
    expect(decay(10, 4, 100)).toBe(0);
    expect(decay(100, 4, 0)).toBe(100);
    expect(decay(200, 4, 0)).toBe(100);
  });
});

describe('addPetXp', () => {
  it('accumulates without a level-up below the threshold', () => {
    const r = addPetXp(1, 0, 10);
    expect(r.level).toBe(1);
    expect(r.xp).toBe(10);
    expect(r.leveledUp).toBe(false);
  });
  it('levels up and carries the remainder', () => {
    const need = xpForLevel(1); // 80
    const r = addPetXp(1, 0, need + 5);
    expect(r.level).toBe(2);
    expect(r.xp).toBe(5);
    expect(r.leveledUp).toBe(true);
  });
  it('can jump multiple levels at once', () => {
    const r = addPetXp(1, 0, 1000);
    expect(r.level).toBeGreaterThan(2);
  });
});

describe('mood', () => {
  it('flags starvation and sadness first', () => {
    expect(mood(10, 90)).toContain('جائع');
    expect(mood(90, 10)).toContain('حزين');
  });
  it('is joyful when both are high', () => {
    expect(mood(90, 90)).toContain('سعيد');
  });
});

describe('bar', () => {
  it('renders a 10-cell bar', () => {
    expect(bar(100)).toBe('█'.repeat(10));
    expect(bar(0)).toBe('░'.repeat(10));
    expect(bar(50).length).toBe(10);
  });
});
