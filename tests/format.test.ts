import { describe, it, expect } from 'vitest';
import { displayName, escapeMd, pickRandom } from '../src/utils/format';

describe('format helpers', () => {
  it('prefers first_name for display', () => {
    expect(displayName({ first_name: 'Ali', username: 'ali99', id: 1 })).toBe('Ali');
  });

  it('falls back to @username', () => {
    expect(displayName({ username: 'ali99', id: 1 })).toBe('@ali99');
  });

  it('handles undefined user safely', () => {
    expect(displayName(undefined)).toBe('Unknown');
  });

  it('escapes MarkdownV2 special characters', () => {
    expect(escapeMd('a_b*c')).toBe('a\\_b\\*c');
  });

  it('pickRandom returns an element of the array', () => {
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 20; i++) {
      expect(arr).toContain(pickRandom(arr));
    }
  });
});
