import { describe, it, expect } from 'vitest';
import { rankForLevel, nextRank, crossedRank, RANKS } from '../src/plugins/ranks/logic';

describe('rankForLevel', () => {
  it('returns the base rank at level 0', () => {
    expect(rankForLevel(0).name).toBe('عضو جديد');
  });
  it('picks the highest reached tier', () => {
    expect(rankForLevel(5).name).toBe('عضو نشط');
    expect(rankForLevel(9).name).toBe('عضو نشط'); // not yet 10
    expect(rankForLevel(10).name).toBe('متفاعل');
    expect(rankForLevel(999).name).toBe('خالد');
  });
});

describe('nextRank', () => {
  it('points to the next threshold', () => {
    expect(nextRank(0)?.minLevel).toBe(3);
    expect(nextRank(10)?.minLevel).toBe(20);
  });
  it('is null at the top tier', () => {
    expect(nextRank(100)).toBeNull();
  });
});

describe('crossedRank', () => {
  it('detects crossing into a new rank', () => {
    expect(crossedRank(4, 5)?.name).toBe('عضو نشط');
    expect(crossedRank(19, 20)?.name).toBe('نجم الجروب');
  });
  it('returns null when staying in the same rank', () => {
    expect(crossedRank(5, 6)).toBeNull();
    expect(crossedRank(11, 12)).toBeNull();
  });
});

describe('RANKS integrity', () => {
  it('is sorted ascending by minLevel', () => {
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i].minLevel).toBeGreaterThan(RANKS[i - 1].minLevel);
    }
  });
});
