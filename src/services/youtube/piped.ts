import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/env';
import { createLogger } from '../../core/logger';
import { fetchJson, downloadTo, ffmpegToMp3 } from './media';
import type { DownloadResult, SearchItem, YtError } from './ytdlp';

const log = createLogger('youtube:piped');

/**
 * Extraction via public Piped instances. The request to YouTube originates from
 * the Piped instance (a different IP), so it can succeed when yt-dlp is blocked
 * on the server's datacenter IP. Public instances vary in uptime — we try many.
 */
const DEFAULT_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.darkness.services',
  'https://piped-api.privacydev.net',
  'https://api.piped.yt',
];

function instances(): string[] {
  if (env.YT_PIPED_INSTANCES) {
    return env.YT_PIPED_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_INSTANCES;
}

export async function pipedSearch(
  query: string,
  limit: number,
): Promise<SearchItem[] | { error: YtError }> {
  for (const base of instances()) {
    const data = (await fetchJson(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`)) as
      | { items?: Array<Record<string, unknown>> }
      | null;
    if (!data?.items) continue;

    const items: SearchItem[] = [];
    for (const it of data.items) {
      const videoId = String(it.url ?? '').match(/[?&]v=([\w-]{11})/)?.[1];
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
    const data = (await fetchJson(`${base}/streams/${videoId}`)) as
      | { title?: string; audioStreams?: AudioStream[] }
      | null;
    const streams = data?.audioStreams;
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
      if ((await stat(filePath)).size > 0) {
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
