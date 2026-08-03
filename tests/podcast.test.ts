import { describe, it, expect } from 'vitest';
import {
  parseEpisodes,
  parseItunesShows,
  parseDurationValue,
} from '../src/services/podcast';

describe('parseDurationValue', () => {
  it('parses bare seconds', () => {
    expect(parseDurationValue('3600')).toBe(3600);
  });
  it('parses mm:ss and hh:mm:ss', () => {
    expect(parseDurationValue('45:12')).toBe(45 * 60 + 12);
    expect(parseDurationValue('1:02:03')).toBe(3723);
  });
  it('returns null for missing/garbage', () => {
    expect(parseDurationValue(undefined)).toBeNull();
    expect(parseDurationValue('abc')).toBeNull();
  });
});

describe('parseEpisodes', () => {
  const feed = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[الحلقة الأولى: قصة واقعية]]></title>
      <enclosure url="https://cdn.example.com/ep1.mp3" length="5242880" type="audio/mpeg"/>
      <itunes:duration>45:12</itunes:duration>
      <pubDate>Mon, 01 Jan 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Episode &amp; two</title>
      <enclosure type="audio/mp4" url="https://cdn.example.com/ep2.m4a" length="99999999"/>
      <itunes:duration>3600</itunes:duration>
    </item>
    <item>
      <title>No audio here</title>
      <enclosure url="https://cdn.example.com/video.mp4" length="10" type="video/mp4"/>
    </item>
  </channel></rss>`;

  it('extracts audio episodes with metadata, skipping video enclosures', () => {
    const eps = parseEpisodes(feed);
    expect(eps).toHaveLength(2);
    expect(eps[0].title).toBe('الحلقة الأولى: قصة واقعية');
    expect(eps[0].audioUrl).toBe('https://cdn.example.com/ep1.mp3');
    expect(eps[0].sizeBytes).toBe(5242880);
    expect(eps[0].durationSec).toBe(45 * 60 + 12);
    expect(eps[0].pubDate).toContain('2026');
  });

  it('decodes entities and handles attribute order', () => {
    const eps = parseEpisodes(feed);
    expect(eps[1].title).toBe('Episode & two');
    expect(eps[1].audioUrl).toBe('https://cdn.example.com/ep2.m4a');
    expect(eps[1].durationSec).toBe(3600);
  });

  it('honours the limit', () => {
    expect(parseEpisodes(feed, 1)).toHaveLength(1);
  });

  it('returns empty for a feed with no items', () => {
    expect(parseEpisodes('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('parseItunesShows', () => {
  it('keeps only results that expose a feed URL', () => {
    const json = {
      results: [
        { collectionName: 'فنجان', feedUrl: 'https://feed.example/1', artistName: 'ثمانية' },
        { collectionName: 'No feed show' }, // dropped — no feedUrl
        { trackName: 'Fallback name', feedUrl: 'https://feed.example/2' },
      ],
    };
    const shows = parseItunesShows(json);
    expect(shows).toHaveLength(2);
    expect(shows[0].name).toBe('فنجان');
    expect(shows[0].feedUrl).toBe('https://feed.example/1');
    expect(shows[1].name).toBe('Fallback name');
  });

  it('tolerates a malformed payload', () => {
    expect(parseItunesShows(null)).toEqual([]);
    expect(parseItunesShows({})).toEqual([]);
  });
});
