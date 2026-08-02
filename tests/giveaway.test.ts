import { describe, it, expect } from 'vitest';
import { pickWinner } from '../src/plugins/giveaway/logic';

describe('pickWinner', () => {
  it('returns null for an empty list', () => {
    expect(pickWinner([], () => 0)).toBeNull();
  });
  it('picks by the rand value', () => {
    const ids = [10, 20, 30];
    expect(pickWinner(ids, () => 0)).toBe(10);
    expect(pickWinner(ids, () => 0.5)).toBe(20);
    expect(pickWinner(ids, () => 0.99)).toBe(30);
  });
  it('always returns a member of the list', () => {
    const ids = [1, 2, 3, 4, 5];
    for (let r = 0; r < 1; r += 0.1) {
      expect(ids).toContain(pickWinner(ids, () => r));
    }
  });
});
