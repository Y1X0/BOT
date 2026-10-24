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
// Full current official public-instance list (from TeamPiped/documentation).
// Public instances are flaky and often rate-limited/blocked by YouTube, so we
// list ALL of them and try each — the more we try, the better the odds one is
// healthy at request time. Override with YT_PIPED_INSTANCES when you have a
// private/self-hosted one.
const DEFAULT_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://pipedapi-libre.kavin.rocks',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.owo.si',
  'https://pipedapi.ducks.party',
  'https://piped-api.codespace.cz',
  'https://pipedapi.reallyaweso.me',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services',
  'https://pipedapi.orangenet.cc',
];

function instances(): string[] {
  if (env.YT_PIPED_INSTANCES) {
    return env.YT_PIPED_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_INSTANCES;
}

/** Parse a Piped /search response into our SearchItem shape. */
function parsePipedSearch(data: unknown, limit: number): SearchItem[] {
  const items: SearchItem[] = [];
  const list = (data as { items?: Array<Record<string, unknown>> } | null)?.items;
  if (!list) return items;
  for (const it of list) {
    const videoId = String(it.url ?? '').match(/[?&]v=([\w-]{11})/)?.[1];
    const title = it.title ? String(it.title) : '';
    if (videoId && title) {
      const dur = typeof it.duration === 'number' && it.duration > 0 ? it.duration : null;
      items.push({ videoId, title, duration: dur });
    }
    if (items.length >= limit) break;
  }
  return items;
}

export async function pipedSearch(
  query: string,
  limit: number,
): Promise<SearchItem[] | { error: YtError }> {
  // Race ALL instances in parallel with a short per-request timeout and take the
  // first one that returns results. Public instances are flaky, so trying them
  // sequentially (old behavior) could stall for minutes; racing makes search
  // feel instant — the fastest healthy instance wins in ~1-2s.
  const attempts = instances().map((base) =>
    fetchJson(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`, 5_000).then((data) => {
      const items = parsePipedSearch(data, limit);
      if (items.length) {
        log.info({ base, count: items.length }, 'piped search ok');
        return items;
      }
      throw new Error('no items');
    }),
  );
  try {
    return await Promise.any(attempts);
  } catch {
    return { error: 'failed' };
  }
}

interface AudioStream {
  url?: string;
  mimeType?: string;
  bitrate?: number;
}

interface PipedStreams {
  base: string;
  title?: string;
  audioStreams?: AudioStream[];
}

/**
 * Race `/streams/<id>` across ALL instances in parallel and return the first one
 * that actually has audio streams. With a long instance list, trying them
 * sequentially could stall for over a minute; racing bounds the "find a healthy
 * proxy" time to the single fastest responder.
 */
async function findStreams(videoId: string): Promise<PipedStreams | null> {
  const attempts = instances().map((base) =>
    fetchJson(`${base}/streams/${videoId}`, 8_000).then((data) => {
      const d = data as { title?: string; audioStreams?: AudioStream[] } | null;
      if (!d?.audioStreams?.length) {
        log.warn({ base }, 'piped dl: no audioStreams');
        throw new Error('no streams');
      }
      log.info({ base, streams: d.audioStreams.length }, 'piped dl: got streams');
      return { base, title: d.title, audioStreams: d.audioStreams };
    }),
  );
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

export async function pipedDownload(videoId: string): Promise<DownloadResult | { error: YtError }> {
  const found = await findStreams(videoId);
  if (!found) return { error: 'failed' };
  const { base } = found;
  const streams = found.audioStreams ?? [];

  const sorted = [...streams].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const chosen = sorted.find((s) => /mp4/i.test(s.mimeType ?? '')) ?? sorted[0];
  if (!chosen?.url) {
    log.warn({ base, count: streams.length }, 'piped dl: no usable stream url');
    return { error: 'failed' };
  }
  // Redacted: host only tells us proxied (pipedproxy/instance) vs direct
  // googlevideo (which the datacenter IP typically blocks).
  let urlHost = '?';
  try {
    urlHost = new URL(chosen.url).host;
  } catch {
    /* ignore */
  }
  log.info({ base, urlHost, streams: streams.length }, 'piped dl: got stream url');

  const title = found.title ? String(found.title) : 'audio';
  const isMp4 = /mp4/i.test(chosen.mimeType ?? '');
  const dir = await mkdtemp(join(tmpdir(), 'pd-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const rawPath = join(dir, isMp4 ? 'audio.m4a' : 'audio.src');

  try {
    if (!(await downloadTo(chosen.url, rawPath))) {
      await cleanup();
      return { error: 'failed' };
    }
    let filePath = rawPath;
    if (!isMp4) {
      const mp3 = join(dir, 'audio.mp3');
      if (!(await ffmpegToMp3(rawPath, mp3))) {
        await cleanup();
        return { error: 'failed' };
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
  return { error: 'failed' };
}
