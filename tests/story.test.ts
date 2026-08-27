import { describe, it, expect } from 'vitest';
import { parseStoryLink, storyFromMessage } from '../src/plugins/story';

describe('parseStoryLink', () => {
  it('parses a full https story link', () => {
    expect(parseStoryLink('https://t.me/durov/s/12')).toEqual({ username: 'durov', storyId: 12 });
  });
  it('parses a scheme-less link and one embedded in text', () => {
    expect(parseStoryLink('t.me/some_user/s/3')).toEqual({ username: 'some_user', storyId: 3 });
    expect(parseStoryLink('شوف هاي https://t.me/News_Ch/s/456 حلوة')).toEqual({ username: 'News_Ch', storyId: 456 });
  });
  it('ignores trailing path/query', () => {
    expect(parseStoryLink('https://t.me/user123/s/7?single')).toEqual({ username: 'user123', storyId: 7 });
  });
  it('returns null for non-story Telegram links and junk', () => {
    expect(parseStoryLink('https://t.me/durov/99')).toBeNull(); // a message, not a story
    expect(parseStoryLink('https://t.me/joinchat/abcd')).toBeNull();
    expect(parseStoryLink('just some text')).toBeNull();
    expect(parseStoryLink('')).toBeNull();
  });
});

describe('storyFromMessage', () => {
  it('reads a shared story from a poster WITH a username', () => {
    const msg = { story: { id: 8, chat: { id: 123, username: 'someone' } } };
    expect(storyFromMessage(msg)).toEqual({ peer: 'someone', storyId: 8, label: '@someone' });
  });
  it('reads a shared story from a poster with NO username (numeric peer)', () => {
    const msg = { story: { id: 4, chat: { id: 555, first_name: 'أحمد' } } };
    expect(storyFromMessage(msg)).toEqual({ peer: 555, storyId: 4, label: 'أحمد' });
  });
  it('returns null when there is no story', () => {
    expect(storyFromMessage({ text: 'hi' })).toBeNull();
    expect(storyFromMessage(undefined)).toBeNull();
    expect(storyFromMessage({ story: { id: 0, chat: { id: 1 } } })).toBeNull();
  });
});
