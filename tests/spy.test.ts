import { describe, it, expect } from 'vitest';
import { assignRoles, SPY_WORDS } from '../src/plugins/spy/logic';

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('assignRoles', () => {
  it('picks the spy and word by the injected rand', () => {
    const players = [10, 20, 30, 40];
    // rand #1 → index 2 (spy=30); rand #2 → word index 0.
    const r = assignRoles(players, SPY_WORDS, seq([2 / 4 + 0.01, 0]));
    expect(r.spyId).toBe(30);
    expect(r.word).toBe(SPY_WORDS[0]);
    expect(players).toContain(r.spyId);
  });

  it('always returns a real player and a real word', () => {
    const players = [1, 2, 3];
    for (const p of [0, 0.34, 0.67, 0.99]) {
      const r = assignRoles(players, SPY_WORDS, seq([p, p]));
      expect(players).toContain(r.spyId);
      expect(SPY_WORDS).toContain(r.word);
    }
  });
});
