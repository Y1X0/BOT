import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../../config/env';
import { createLogger } from '../../core/logger';
import type { DownloadResult, SearchItem, YtError } from './ytdlp';

const log = createLogger('youtube:piped');

/**
 * Alternative extraction engine using public Piped API instances. Because the
 * request to YouTube originates from the Piped instance (a different IP), this
 * can succeed when yt-dlp is blocked on the server's datacenter IP. Public
 * instances vary in uptime, so we try several and fall through.
 */
const DEFAULT_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
];

function instances(): string[] {
  if (env.YT_PIPED_INSTANCES) {
    return env.YT_PIPED_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_INSTANCES;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchJson(url: string, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function pipedSearch(
  query: string,
  limit: number,
): Promise<SearchItem[] | { error: YtError }> {
  for (const base of instances()) {
    const data = await fetchJson(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`);
    const rawItems = (data?.items as Array<Record<string, unknown>>) ?? null;
    if (!rawItems) continue;

    const items: SearchItem[] = [];
    for (const it of rawItems) {
      const url = String(it.url ?? '');
      const videoId = url.match(/[?&]v=([\w-]{11})/)?.[1];
      const title = it.title ? String(it.title) : '';
      if (videoId && title) {
        const dur = typeof it.duration === 'number' && it.duration > 0 ? it.duration : null;
        items.push({ videoId, title, duration: dur });
      }
      if (items.length >= limit) break;
    }
    if (items.length) {
      log.info({ base, count: items.length }, 'piped search ok');
      return items;
    }
  }
  return { error: 'failed' };
}

interface AudioStream {
  url?: string;
  mimeType?: string;
  bitrate?: number;
}

export async function pipedDownload(videoId: string): Promise<DownloadResult | { error: YtError }> {
  for (const base of instances()) {
    const data = await fetchJson(`${base}/streams/${videoId}`);
    const streams = (data?.audioStreams as AudioStream[]) ?? null;
    if (!streams?.length) continue;

    const sorted = [...streams].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const chosen = sorted.find((s) => /mp4/i.test(s.mimeType ?? '')) ?? sorted[0];
    if (!chosen?.url) continue;

    const title = data?.title ? String(data.title) : 'audio';
    const isMp4 = /mp4/i.test(chosen.mimeType ?? '');
    const dir = await mkdtemp(join(tmpdir(), 'pd-'));
    const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const rawPath = join(dir, isMp4 ? 'audio.m4a' : 'audio.src');

    try {
      if (!(await downloadTo(chosen.url, rawPath))) {
        await cleanup();
        continue;
      }
      let filePath = rawPath;
      if (!isMp4) {
        const mp3 = join(dir, 'audio.mp3');
        if (!(await ffmpegToMp3(rawPath, mp3))) {
          await cleanup();
          continue;
        }
        filePath = mp3;
      }
      const s = await stat(filePath);
      if (s.size > 0) {
        log.info({ base }, 'piped download ok');
        return { filePath, title, cleanup };
      }
      await cleanup();
    } catch (err) {
      log.warn({ err, base }, 'piped download error');
      await cleanup();
    }
  }
  return { error: 'blocked' };
}

async function downloadTo(url: string, dest: string): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 120_000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok || !r.body) return false;
    await pipeline(Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function ffmpegToMp3(input: string, output: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-y', '-i', input, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', output], {
      stdio: 'ignore',
    });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}
