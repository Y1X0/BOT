import { describe, it, expect } from 'vitest';
import { marriedDuration } from '../src/plugins/marriage/logic';

describe('marriedDuration', () => {
  const base = new Date('2026-08-02T12:00:00Z');
  const ago = (days: number) => new Date(base.getTime() - days * 86_400_000);

  it('says today for < 1 day', () => {
    expect(marriedDuration(ago(0), base)).toContain('اليوم');
  });
  it('handles singular/dual/plural days', () => {
    expect(marriedDuration(ago(1), base)).toBe('يوم واحد');
    expect(marriedDuration(ago(2), base)).toBe('يومان');
    expect(marriedDuration(ago(5), base)).toBe('5 أيام');
    expect(marriedDuration(ago(15), base)).toBe('15 يوماً');
  });
  it('rolls up to months and years', () => {
    expect(marriedDuration(ago(60), base)).toBe('2 أشهر');
    expect(marriedDuration(ago(400), base)).toBe('سنة');
    expect(marriedDuration(ago(800), base)).toBe('2 سنوات');
  });
  it('never goes negative', () => {
    expect(marriedDuration(new Date(base.getTime() + 100000), base)).toContain('اليوم');
  });
});
