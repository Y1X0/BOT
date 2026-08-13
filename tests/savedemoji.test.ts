import { describe, it, expect } from 'vitest';
import { extractCustomEmoji } from '../src/services/savedemoji.service';

describe('extractCustomEmoji', () => {
  it('pulls custom_emoji entities with their base char and id', () => {
    const text = '😀🔥';
    const entities = [
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: 'aaa' },
      { type: 'custom_emoji', offset: 2, length: 2, custom_emoji_id: 'bbb' },
    ];
    const out = extractCustomEmoji(text, entities);
    expect(out).toEqual([
      { e: '😀', id: 'aaa' },
      { e: '🔥', id: 'bbb' },
    ]);
  });

  it('ignores non-custom-emoji entities', () => {
    const out = extractCustomEmoji('hello', [{ type: 'bold', offset: 0, length: 5 }]);
    expect(out).toEqual([]);
  });

  it('returns empty for no entities', () => {
    expect(extractCustomEmoji('hi')).toEqual([]);
  });
});
