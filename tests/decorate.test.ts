import { describe, it, expect } from 'vitest';
import { decorate } from '../src/plugins/decorate/decorate';
import { matchAlias } from '../src/plugins/aliases';

describe('text decoration', () => {
  it('returns multiple variants for Arabic input', () => {
    const out = decorate('طاولة');
    expect(out.length).toBeGreaterThan(5);
    // Every frame variant should still contain the original word.
    expect(out.some((v) => v.includes('طاولة'))).toBe(true);
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
