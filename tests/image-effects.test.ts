import { describe, it, expect } from 'vitest';
import { EFFECTS, EFFECT_GROUPS, findEffect } from '../src/services/image/effects';

describe('image effects registry', () => {
  it('has effects and unique ids', () => {
    expect(EFFECTS.length).toBeGreaterThan(10);
    const ids = EFFECTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every effect carries a face-preserving, non-sexual prompt', () => {
    for (const e of EFFECTS) {
      expect(e.prompt).toContain('Preserve the person');
      expect(e.prompt.toLowerCase()).toContain('non-sexual');
      expect(e.emoji).toBeTruthy();
      expect(e.label).toBeTruthy();
    }
  });

  it('groups are derived from effects and non-empty', () => {
    expect(EFFECT_GROUPS.length).toBeGreaterThan(0);
    for (const g of EFFECT_GROUPS) {
      expect(EFFECTS.some((e) => e.group === g)).toBe(true);
    }
  });

  it('findEffect resolves known ids and rejects unknown', () => {
    expect(findEffect(EFFECTS[0].id)?.id).toBe(EFFECTS[0].id);
    expect(findEffect('does-not-exist')).toBeUndefined();
  });
});
