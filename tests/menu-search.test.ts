import { describe, it, expect } from 'vitest';
import { searchMenu, CATEGORY_COLORS } from '../src/plugins/menu/logic';
import { MENU } from '../src/plugins/menu/data';

describe('searchMenu', () => {
  it('finds by Arabic trigger', () => {
    const hits = searchMenu('بنك');
    expect(hits.some((h) => h.item.cmd === 'bank')).toBe(true);
  });
  it('finds by command name', () => {
    expect(searchMenu('hangman').some((h) => h.item.cmd === 'hangman')).toBe(true);
  });
  it('ignores diacritics/alef forms', () => {
    expect(searchMenu('إيداع').some((h) => h.item.cmd === 'deposit')).toBe(true);
  });
  it('returns empty for no match and blank query', () => {
    expect(searchMenu('zzzznotacommand')).toEqual([]);
    expect(searchMenu('')).toEqual([]);
  });
  it('respects the limit', () => {
    expect(searchMenu('ا', 5).length).toBeLessThanOrEqual(5);
  });
});

describe('CATEGORY_COLORS', () => {
  it('has a color for every menu category', () => {
    for (const c of MENU) expect(CATEGORY_COLORS[c.key]).toBeTruthy();
  });
});
