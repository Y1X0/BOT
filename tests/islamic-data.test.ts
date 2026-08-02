import { describe, it, expect } from 'vitest';
import { AYAT, AHADITH, ATHKAR } from '../src/plugins/islamic/data';

describe('islamic content', () => {
  it('has a sizable, unique set of verses', () => {
    expect(AYAT.length).toBeGreaterThanOrEqual(20);
    expect(new Set(AYAT).size).toBe(AYAT.length);
  });
  it('every verse is wrapped in Qur\'an brackets with a reference', () => {
    for (const a of AYAT) {
      expect(a).toContain('﴿');
      expect(a).toContain('﴾');
      expect(a).toMatch(/\[[^\]]+\]/);
    }
  });
  it('has a large, unique set of hadith, each attributed to a source', () => {
    expect(AHADITH.length).toBeGreaterThanOrEqual(40);
    expect(new Set(AHADITH).size).toBe(AHADITH.length);
    for (const h of AHADITH) {
      expect(h).toContain('«');
      expect(h).toMatch(/رواه|متفق عليه|البخاري|مسلم/);
    }
  });
  it('has an expanded athkar list', () => {
    expect(ATHKAR.length).toBeGreaterThanOrEqual(15);
    expect(new Set(ATHKAR).size).toBe(ATHKAR.length);
  });
});
