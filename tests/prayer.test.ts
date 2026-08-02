import { describe, it, expect } from 'vitest';
import { parseHHMM, matchPrayer, PRAYERS } from '../src/plugins/islamic/schedule';
import { to12h } from '../src/utils/time';

describe('parseHHMM', () => {
  it('parses HH:MM (with optional suffix) to minutes', () => {
    expect(parseHHMM('05:12')).toBe(5 * 60 + 12);
    expect(parseHHMM('12:34 (EET)')).toBe(12 * 60 + 34);
    expect(parseHHMM('nope')).toBeNull();
    expect(parseHHMM(undefined)).toBeNull();
  });
});

describe('matchPrayer', () => {
  const timings = { Fajr: '04:30', Dhuhr: '12:45', Asr: '16:10', Maghrib: '19:20', Isha: '20:50' };
  it('matches the exact prayer minute', () => {
    expect(matchPrayer(12 * 60 + 45, timings)?.key).toBe('Dhuhr');
    expect(matchPrayer(20 * 60 + 50, timings)?.ar).toBe('العشاء');
  });
  it('returns null when no prayer matches', () => {
    expect(matchPrayer(13 * 60, timings)).toBeNull();
  });
  it('covers the five daily prayers', () => {
    expect(PRAYERS.map((p) => p.key)).toEqual(['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
  });
});

describe('to12h', () => {
  it('converts 24h to 12h Arabic AM/PM', () => {
    expect(to12h('00:15')).toBe('12:15 ص');
    expect(to12h('09:05')).toBe('9:05 ص');
    expect(to12h('12:00')).toBe('12:00 م');
    expect(to12h('13:30')).toBe('1:30 م');
    expect(to12h('20:50')).toBe('8:50 م');
  });
  it('handles suffixes and leaves junk untouched', () => {
    expect(to12h('19:20 (EET)')).toBe('7:20 م');
    expect(to12h('—')).toBe('—');
  });
});
