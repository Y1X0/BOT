import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../core/logger';

const log = createLogger('podcast');

/**
 * Re-encode an audio file to low-bitrate mono MP3 so a long episode fits under
 * Telegram's bot upload cap. Speech is fine at 32–96 kbps; the bitrate is
 * chosen from the episode duration to target ~`targetBytes`. Returns the new
 * file path (same dir), or null on failure.
 */
export async function compressAudio(
  inputPath: string,
  durationSec: number | null,
  targetBytes: number,
): Promise<string | null> {
  // kbps that would land near the target for the whole duration (with headroom).
  let kbps = 48;
  if (durationSec && durationSec > 0) {
    kbps = Math.floor((targetBytes * 8) / (durationSec * 1000));
    kbps = Math.max(32, Math.min(128, kbps));
  }
  const out = inputPath.replace(/\.[^.]+$/, '') + `.c${kbps}.mp3`;
  const args = ['-y', '-i', inputPath, '-vn', '-ac', '1', '-b:a', `${kbps}k`, '-f', 'mp3', out];
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 8 * 60_000).unref?.();
    p.on('error', () => resolve(false));
    p.on('close', (code) => {
      if (timer) clearTimeout(timer as unknown as NodeJS.Timeout);
      resolve(code === 0);
    });
  });
  if (!ok) return null;
  const size = await stat(out).then((s) => s.size).catch(() => Infinity);
  return Number.isFinite(size) ? out : null;
}

export interface PodcastShow {
  name: string;
  feedUrl: string;
  artist?: string;
}

export interface PodcastEpisode {
  title: string;
  audioUrl: string;
  sizeBytes: number | null;
  durationSec: number | null;
  pubDate?: string;
}

export type PodcastError = { error: 'notfound' | 'failed' };

const UA = 'Mozilla/5.0 (compatible; TelegramBot/1.0)';

/** Strip CDATA / decode a handful of common XML entities. */
function decodeXml(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

/** Parse an itunes:duration value ("3600", "1:02:03" or "45:12") into seconds. */
export function parseDurationValue(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const parts = v.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Parse a podcast RSS feed into episodes (feed order, newest first). Pure so it
 * can be unit-tested. Only `<item>`s carrying an audio `<enclosure>` are kept.
 */
export function parseEpisodes(xml: string, limit = 8): PodcastEpisode[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const episodes: PodcastEpisode[] = [];
  for (const item of items) {
    const enclosure = /<enclosure\b[^>]*>/i.exec(item)?.[0];
    if (!enclosure) continue;
    const url = /\burl\s*=\s*"([^"]+)"/i.exec(enclosure)?.[1];
    if (!url) continue;
    const type = /\btype\s*=\s*"([^"]*)"/i.exec(enclosure)?.[1] ?? '';
    // Skip video enclosures — this feature delivers audio only.
    if (type && !/audio|mpeg|mp3|m4a|ogg|aac|x-m4a/i.test(type)) continue;
    const lengthRaw = /\blength\s*=\s*"(\d+)"/i.exec(enclosure)?.[1];
    const titleRaw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(item)?.[1];
    const durationRaw = /<itunes:duration\b[^>]*>([\s\S]*?)<\/itunes:duration>/i.exec(item)?.[1];
    const pubRaw = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i.exec(item)?.[1];
    episodes.push({
      title: titleRaw ? decodeXml(titleRaw) : 'حلقة',
      audioUrl: decodeXml(url),
      sizeBytes: lengthRaw ? Number(lengthRaw) : null,
      durationSec: parseDurationValue(durationRaw),
      pubDate: pubRaw ? decodeXml(pubRaw) : undefined,
    });
    if (episodes.length >= limit) break;
  }
  return episodes;
}

interface ItunesResult {
  collectionName?: string;
  trackName?: string;
  feedUrl?: string;
  artistName?: string;
}

/** Map an iTunes Search API payload to shows that expose an RSS feed. */
export function parseItunesShows(json: unknown, limit = 8): PodcastShow[] {
  const results = (json as { results?: ItunesResult[] })?.results ?? [];
  const shows: PodcastShow[] = [];
  for (const r of results) {
    if (!r.feedUrl) continue;
    shows.push({
      name: r.collectionName ?? r.trackName ?? 'بودكاست',
      feedUrl: r.feedUrl,
      artist: r.artistName,
    });
    if (shows.length >= limit) break;
  }
  return shows;
}

/** Search Apple's public podcast directory (free, no API key). */
export async function searchPodcasts(term: string, limit = 8): Promise<PodcastShow[] | PodcastError> {
  const url =
    `https://itunes.apple.com/search?media=podcast&entity=podcast&country=SA&limit=${limit * 2}` +
    `&term=${encodeURIComponent(term)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return { error: 'failed' };
    const shows = parseItunesShows(await res.json(), limit);
    return shows.length ? shows : { error: 'notfound' };
  } catch (err) {
    log.warn({ err }, 'podcast search failed');
    return { error: 'failed' };
  }
}

/** Fetch a feed and return its most recent episodes. */
export async function fetchEpisodes(feedUrl: string, limit = 8): Promise<PodcastEpisode[] | PodcastError> {
  try {
    const res = await fetch(feedUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) return { error: 'failed' };
    const eps = parseEpisodes(await res.text(), limit);
    return eps.length ? eps : { error: 'notfound' };
  } catch (err) {
    log.warn({ err }, 'podcast feed fetch failed');
    return { error: 'failed' };
  }
}

export interface AudioFile {
  filePath: string;
  cleanup: () => Promise<void>;
}

/** Download an episode to a temp file, refusing anything over `maxBytes`. */
export async function downloadAudio(
  url: string,
  maxBytes: number,
): Promise<AudioFile | { error: 'toolarge' | 'failed' }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) return { error: 'failed' };
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared && declared > maxBytes) return { error: 'toolarge' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { error: 'toolarge' };
    const dir = await mkdtemp(join(tmpdir(), 'pod-'));
    const ext = /\.(mp3|m4a|aac|ogg|opus|mpga)(?:\?|$)/i.exec(url)?.[1] ?? 'mp3';
    const filePath = join(dir, `episode.${ext}`);
    await writeFile(filePath, buf);
    return { filePath, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined) };
  } catch (err) {
    log.warn({ err }, 'podcast download failed');
    return { error: 'failed' };
  }
}
