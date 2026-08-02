import { describe, it, expect } from 'vitest';
import { parseChoices, pick, EIGHTBALL } from '../src/plugins/decide/logic';

describe('parseChoices', () => {
  it('splits on Arabic "او"/"أو"/"ولا"', () => {
    expect(parseChoices('قهوة او شاي')).toEqual(['قهوة', 'شاي']);
    expect(parseChoices('نروح أو نقعد')).toEqual(['نروح', 'نقعد']);
    expect(parseChoices('هذا ولا ذاك')).toEqual(['هذا', 'ذاك']);
  });
  it('splits on commas and pipes', () => {
    expect(parseChoices('أحمر، أخضر، أزرق')).toEqual(['أحمر', 'أخضر', 'أزرق']);
    expect(parseChoices('a | b | c')).toEqual(['a', 'b', 'c']);
  });
  it('drops empties and trims', () => {
    expect(parseChoices('  x ,  , y ')).toEqual(['x', 'y']);
  });
  it('returns a single element when no separators', () => {
    expect(parseChoices('واحد')).toEqual(['واحد']);
  });
});

describe('pick', () => {
  it('selects by rand', () => {
    expect(pick(['a', 'b', 'c'], () => 0)).toBe('a');
    expect(pick(['a', 'b', 'c'], () => 0.99)).toBe('c');
  });
  it('8ball answers are non-empty', () => {
    expect(EIGHTBALL.length).toBeGreaterThan(5);
    expect(EIGHTBALL.every((a) => a.length > 0)).toBe(true);
  });
});
