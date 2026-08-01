import { describe, it, expect } from 'vitest';
import { decorate } from '../src/plugins/decorate/decorate';
import { matchAlias } from '../src/plugins/aliases';

describe('text decoration', () => {
  it('returns many distinct variants for Arabic input', () => {
    const out = decorate('طاولة');
    expect(out.length).toBeGreaterThan(15);
    // Letters are preserved (decorated), so each variant keeps the letters.
    expect(out.every((v) => v.includes('ط') && v.includes('ة'))).toBe(true);
    // No variant equals the plain input.
    expect(out).not.toContain('طاولة');
  });

  it('adds Latin fancy fonts when input has ASCII letters', () => {
    const out = decorate('table');
    // Mathematical bold "table" starts with 𝐭
    expect(out.some((v) => v.includes('𝐭'))).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(decorate('   ')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(decorate('x', 5).length).toBeLessThanOrEqual(5);
  });

  it('produces de-duplicated results', () => {
    const out = decorate('طاولة');
    expect(new Set(out).size).toBe(out.length);
  });

  it('is reachable via the Arabic alias', () => {
    expect(matchAlias('زخرفة طاولة')).toBe('/decorate طاولة');
    expect(matchAlias('زخرف table')).toBe('/decorate table');
  });
});
