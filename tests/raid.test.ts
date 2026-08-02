import { describe, it, expect } from 'vitest';
import { makeRaidState, recordJoin, inRaid } from '../src/plugins/protection/raid';

const T = 5, W = 10_000, C = 60_000;

describe('anti-raid detector', () => {
  it('does not trigger below the threshold', () => {
    const s = makeRaidState();
    let last;
    for (let i = 0; i < T - 1; i++) last = recordJoin(s, 1000 + i * 100, T, W, C);
    expect(last!.raid).toBe(false);
  });

  it('triggers exactly at the threshold within the window', () => {
    const s = makeRaidState();
    let res;
    for (let i = 0; i < T; i++) res = recordJoin(s, 1000 + i * 100, T, W, C);
    expect(res!.raid).toBe(true);
    expect(res!.justTriggered).toBe(true);
  });

  it('does not trigger when joins are spread beyond the window', () => {
    const s = makeRaidState();
    let res;
    for (let i = 0; i < T; i++) res = recordJoin(s, i * (W + 1000), T, W, C); // one join per >window
    expect(res!.raid).toBe(false);
  });

  it('stays in raid mode during cooldown, only triggers once', () => {
    const s = makeRaidState();
    let res;
    for (let i = 0; i < T; i++) res = recordJoin(s, 1000 + i * 100, T, W, C);
    expect(res!.justTriggered).toBe(true);
    const next = recordJoin(s, 2000, T, W, C);
    expect(next.raid).toBe(true);
    expect(next.justTriggered).toBe(false); // already raiding
    expect(inRaid(s, 2000)).toBe(true);
    expect(inRaid(s, 1000 + C + 1000)).toBe(false); // after cooldown
  });
});
