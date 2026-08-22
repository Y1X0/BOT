import { describe, it, expect } from 'vitest';
import { normalizeTitle, longestToken, similarity } from '../src/services/archive/normalize';

describe('normalizeTitle — the foundation of archive search', () => {
  it('strips Arabic tashkeel (harakat)', () => {
    expect(normalizeTitle('مُحَمَّد')).toBe('محمد');
    expect(normalizeTitle('السَّلامُ عَلَيْكُم')).toBe('السلام عليكم');
  });

  it('strips tatweel', () => {
    expect(normalizeTitle('جـــمـــيـــل')).toBe('جميل');
  });

  it('unifies hamza forms أ إ آ ٱ → ا', () => {
    expect(normalizeTitle('أحمد')).toBe('احمد');
    expect(normalizeTitle('إيمان')).toBe('ايمان');
    expect(normalizeTitle('آمال')).toBe('امال');
  });

  it('maps alef maqsura ى → ي and ta marbuta ة → ه', () => {
    expect(normalizeTitle('ليلى')).toBe('ليلي');
    expect(normalizeTitle('أغنية')).toBe('اغنيه');
  });

  it('lowercases Latin', () => {
    expect(normalizeTitle('NaNCy Ajram')).toBe('nancy ajram');
  });

  it('drops punctuation/symbols and collapses whitespace', () => {
    expect(normalizeTitle('فيروز  -  البنت!!')).toBe('فيروز البنت');
    expect(normalizeTitle('  hello,   world.  ')).toBe('hello world');
  });

  it('handles empty / nullish input', () => {
    expect(normalizeTitle('')).toBe('');
    // @ts-expect-error testing runtime guard
    expect(normalizeTitle(undefined)).toBe('');
  });

  it('matches differently-written forms of the same title', () => {
    // decorated/spaced/tashkeel'd variants normalize to the same key
    expect(normalizeTitle('نانْسي عَجرم')).toBe(normalizeTitle('نانسي عجرم'));
    expect(normalizeTitle('ليلى مراد')).toBe(normalizeTitle('ليلي مراد'));
  });
});

describe('longestToken', () => {
  it('returns the longest word', () => {
    expect(longestToken('نانسي عجرم')).toBe('نانسي');
    expect(longestToken('a bb ccc')).toBe('ccc');
    expect(longestToken('')).toBe('');
  });
});

describe('similarity', () => {
  it('scores exact and substring highest', () => {
    expect(similarity('نانسي عجرم', 'نانسي عجرم')).toBe(1);
    expect(similarity('نانسي', 'نانسي عجرم')).toBeGreaterThanOrEqual(0.9);
  });
  it('scores token overlap', () => {
    expect(similarity('عجرم نانسي', 'نانسي حسام')).toBeGreaterThan(0);
    expect(similarity('نانسي', 'فيروز')).toBe(0);
  });
});
