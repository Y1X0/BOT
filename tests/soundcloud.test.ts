import { describe, it, expect } from 'vitest';
import { parseScResults } from '../src/services/soundcloud';

describe('parseScResults', () => {
  it('parses url/title/duration lines', () => {
    const out = 'https://soundcloud.com/a/track1\tأغنية أولى\t210\nhttps://soundcloud.com/b/track2\tSecond\t185.4';
    const items = parseScResults(out);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ url: 'https://soundcloud.com/a/track1', title: 'أغنية أولى', duration: 210 });
    expect(items[1].duration).toBe(185); // rounded
  });
  it('skips malformed / non-http lines', () => {
    const out = 'not-a-url\ttitle\t10\n\nhttps://x.com/t\tok\tNA';
    const items = parseScResults(out);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://x.com/t');
    expect(items[0].duration).toBeNull();
  });
  it('returns empty for empty output', () => {
    expect(parseScResults('')).toEqual([]);
  });
});
