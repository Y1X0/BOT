import { describe, it, expect } from 'vitest';
import { formatWeeklyReport, isWeeklyDue } from '../src/plugins/reports/logic';

describe('formatWeeklyReport', () => {
  it('renders totals, medals, and xp leader', () => {
    const out = formatWeeklyReport({
      title: 'جروبنا',
      activeMembers: 3,
      weeklyMessages: 42,
      top: [
        { name: 'سامي', count: 20 },
        { name: 'ليان', count: 15 },
        { name: 'راكان', count: 7 },
      ],
      newXpLeader: { name: 'سامي', xp: 500 },
    });
    expect(out).toContain('جروبنا');
    expect(out).toContain('42');
    expect(out).toContain('🥇 سامي — 20');
    expect(out).toContain('500 XP');
  });

  it('handles an empty week gracefully', () => {
    const out = formatWeeklyReport({ title: 'x', activeMembers: 0, weeklyMessages: 0, top: [] });
    expect(out).toContain('لا نشاط');
  });
});

describe('isWeeklyDue', () => {
  const friday6pm = new Date('2026-08-07T18:00:00Z'); // Friday
  it('fires on the target weekday and hour with no prior send', () => {
    expect(isWeeklyDue(friday6pm, null)).toBe(true);
  });
  it('does not fire on the wrong day or hour', () => {
    expect(isWeeklyDue(new Date('2026-08-06T18:00:00Z'), null)).toBe(false); // Thursday
    expect(isWeeklyDue(new Date('2026-08-07T17:00:00Z'), null)).toBe(false); // 5pm
  });
  it('does not double-fire within the same week', () => {
    const lastSent = new Date('2026-08-07T18:00:00Z');
    expect(isWeeklyDue(new Date('2026-08-07T18:30:00Z'), lastSent)).toBe(false);
  });
  it('fires again after a full week', () => {
    const lastSent = new Date('2026-07-31T18:00:00Z');
    expect(isWeeklyDue(friday6pm, lastSent)).toBe(true);
  });
});
