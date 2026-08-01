import { describe, it, expect } from 'vitest';
import { ACHIEVEMENTS } from '../src/services/achievements.service';
import { findItem, SHOP_ITEMS } from '../src/services/shop.service';
import { MISSIONS } from '../src/services/missions.service';
import { normalizeTime } from '../src/services/scheduled.service';

describe('achievements', () => {
  const base = { messageCount: 0, xp: 0, level: 0, gamesWon: 0, joinedAt: new Date() };

  it('msg100 unlocks at 100 messages', () => {
    const a = ACHIEVEMENTS.find((x) => x.code === 'msg100')!;
    expect(a.met({ ...base, messageCount: 99 })).toBe(false);
    expect(a.met({ ...base, messageCount: 100 })).toBe(true);
  });

  it('games10 needs 10 wins', () => {
    const a = ACHIEVEMENTS.find((x) => x.code === 'games10')!;
    expect(a.met({ ...base, gamesWon: 9 })).toBe(false);
    expect(a.met({ ...base, gamesWon: 10 })).toBe(true);
  });

  it('veteran30 needs 30 days membership', () => {
    const a = ACHIEVEMENTS.find((x) => x.code === 'veteran30')!;
    const old = new Date(Date.now() - 31 * 24 * 3600_000);
    expect(a.met({ ...base, joinedAt: new Date() })).toBe(false);
    expect(a.met({ ...base, joinedAt: old })).toBe(true);
  });

  it('every achievement grants positive coins', () => {
    for (const a of ACHIEVEMENTS) expect(a.coins).toBeGreaterThan(0);
  });
});

describe('shop', () => {
  it('finds items case-insensitively', () => {
    expect(findItem('KING')?.id).toBe('king');
    expect(findItem('nope')).toBeUndefined();
  });
  it('all items have positive prices and unique ids', () => {
    const ids = new Set(SHOP_ITEMS.map((i) => i.id));
    expect(ids.size).toBe(SHOP_ITEMS.length);
    for (const i of SHOP_ITEMS) expect(i.price).toBeGreaterThan(0);
  });
});

describe('missions config', () => {
  it('has positive targets and rewards', () => {
    for (const m of Object.values(MISSIONS)) {
      expect(m.target).toBeGreaterThan(0);
      expect(m.reward).toBeGreaterThan(0);
    }
  });
});

describe('scheduled time normalization', () => {
  it('pads and validates', () => {
    expect(normalizeTime('8:00')).toBe('08:00');
    expect(normalizeTime('23:59')).toBe('23:59');
  });
  it('rejects invalid times', () => {
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('8:60')).toBeNull();
    expect(normalizeTime('abc')).toBeNull();
  });
});
