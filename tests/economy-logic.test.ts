import { describe, it, expect } from 'vitest';
import {
  robOutcome,
  spinSlots,
  SLOT_SYMBOLS,
  workReward,
  crimeOutcome,
  WORK_MIN,
  WORK_MAX,
  WORK_JOBS,
  CRIME_SUCCESS_CHANCE,
} from '../src/services/economy-logic';

// Deterministic rand from a queue of values.
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('robOutcome', () => {
  it('succeeds when the roll is below the success chance', () => {
    const r = robOutcome(1000, 500, seq([0.1, 0.5])); // 0.1<0.4 → success; pct=0.1+0.5*0.2=0.2
    expect(r.success).toBe(true);
    expect(r.amount).toBe(200); // 20% of 1000
  });
  it('gets caught when the roll is above the success chance', () => {
    const r = robOutcome(1000, 500, seq([0.9])); // caught → 10% of robber wallet
    expect(r.success).toBe(false);
    expect(r.amount).toBe(50);
  });
  it('never steals less than 1', () => {
    const r = robOutcome(1, 0, seq([0.0, 0.0]));
    expect(r.amount).toBeGreaterThanOrEqual(1);
  });
});

describe('spinSlots', () => {
  it('pays 10x for three 7s', () => {
    const sevenIdx = SLOT_SYMBOLS.indexOf('7️⃣') / SLOT_SYMBOLS.length + 0.001;
    const r = spinSlots(seq([sevenIdx, sevenIdx, sevenIdx]));
    expect(r.reels.every((x) => x === '7️⃣')).toBe(true);
    expect(r.mult).toBe(10);
  });
  it('pays 1.5x for a pair', () => {
    const a = 0.01; // first symbol
    const b = 0.5; // different symbol
    const r = spinSlots(seq([a, a, b]));
    expect(r.mult).toBe(1.5);
  });
  it('pays 0 for all-different reels', () => {
    const r = spinSlots(seq([0.01, 0.35, 0.7]));
    expect(r.mult).toBe(0);
  });
});

describe('workReward', () => {
  it('pays within the configured range and picks a real job', () => {
    const r = workReward(seq([0, 0]));
    expect(r.amount).toBeGreaterThanOrEqual(WORK_MIN);
    expect(r.amount).toBeLessThanOrEqual(WORK_MAX);
    expect(WORK_JOBS).toContain(r.job);
  });
  it('reaches the max payout at the top of the range', () => {
    const r = workReward(seq([0, 0.9999]));
    expect(r.amount).toBe(WORK_MAX);
  });
});

describe('crimeOutcome', () => {
  it('succeeds and pays a bounded reward below the success chance', () => {
    const r = crimeOutcome(1000, seq([CRIME_SUCCESS_CHANCE - 0.01, 0, 0]));
    expect(r.success).toBe(true);
    expect(r.amount).toBeGreaterThanOrEqual(150);
    expect(r.amount).toBeLessThanOrEqual(600);
  });
  it('fails and fines 20% of the wallet above the success chance', () => {
    const r = crimeOutcome(1000, seq([0.99, 0]));
    expect(r.success).toBe(false);
    expect(r.amount).toBe(200);
  });
  it('applies a minimum fine of 50 for small wallets', () => {
    const r = crimeOutcome(10, seq([0.99, 0]));
    expect(r.amount).toBe(50);
  });
});
