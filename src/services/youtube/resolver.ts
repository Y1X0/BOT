import { env } from '../../config/env';
import { createLogger } from '../../core/logger';
import { search as ytSearch, downloadAudio as ytDownload, type DownloadResult, type SearchItem, type YtError } from './ytdlp';
import { pipedSearch, pipedDownload } from './piped';
import { invidiousSearch, invidiousDownload } from './invidious';
import { cobaltConfigured, cobaltDownload } from '../cobalt';

const log = createLogger('youtube:resolver');

export type Engine = 'cobalt' | 'yt-dlp' | 'piped' | 'invidious';

/**
 * Try each extraction engine in order until one succeeds:
 *   yt-dlp (fast, direct) → Piped → Invidious (HTTP proxies on other IPs).
 * This maximizes the chance of getting audio when the server IP is blocked.
 */
/** Resolve the FIRST attempt that returns results; if all fail, the last error. */
async function firstSuccess(
  attempts: Promise<SearchItem[] | { error: YtError }>[],
): Promise<SearchItem[] | { error: YtError }> {
  return new Promise((resolve) => {
    let remaining = attempts.length;
    let lastError: { error: YtError } = { error: 'failed' };
    if (!remaining) return resolve(lastError);
    for (const a of attempts) {
      a.then((r) => {
        if (!('error' in r) && r.length) return resolve(r);
        if ('error' in r) lastError = r;
        if (--remaining === 0) resolve(lastError);
      }).catch(() => {
        if (--remaining === 0) resolve(lastError);
      });
    }
  });
}

export async function resolveSearch(query: string, limit: number): Promise<SearchItem[] | { error: YtError }> {
  // Run the HTTP engines (fast, on other IPs) AND yt-dlp IN PARALLEL and take the
  // first that returns results. HTTP usually wins in ~1-2s, so search feels
  // instant; yt-dlp is the reliable backstop when the public instances are down.
  const attempts: Promise<SearchItem[] | { error: YtError }>[] = [ytSearch(query, limit)];
  if (env.YT_PIPED_ENABLED) attempts.push(pipedSearch(query, limit));
  if (env.YT_INVIDIOUS_ENABLED) attempts.push(invidiousSearch(query, limit));
  return firstSuccess(attempts);
}

export async function resolveDownload(
  videoId: string,
  onEngineTry?: (engine: Engine) => void,
  opts: { lowBitrate?: boolean } = {},
): Promise<DownloadResult | { error: YtError }> {
  // Cobalt first when configured: it downloads from its own IP, bypassing the
  // datacenter block that usually defeats direct yt-dlp.
  if (cobaltConfigured()) {
    onEngineTry?.('cobalt');
    const c = await cobaltDownload(`https://www.youtube.com/watch?v=${videoId}`, true);
    if (!('error' in c)) {
      log.info({ engine: 'cobalt' }, 'download resolved');
      return c;
    }
  }

  onEngineTry?.('yt-dlp');
  const yt = await ytDownload(videoId, opts);
  if (!('error' in yt)) {
    log.info({ engine: 'yt-dlp' }, 'download resolved');
    return yt;
  }
  // These are terminal — no engine can fix them.
  if (yt.error === 'notinstalled' || yt.error === 'toolarge') return yt;

  if (env.YT_PIPED_ENABLED) {
    onEngineTry?.('piped');
    const p = await pipedDownload(videoId);
    if (!('error' in p)) {
      log.info({ engine: 'piped' }, 'download resolved');
      return p;
    }
  }
  if (env.YT_INVIDIOUS_ENABLED) {
    onEngineTry?.('invidious');
    const i = await invidiousDownload(videoId);
    if (!('error' in i)) {
      log.info({ engine: 'invidious' }, 'download resolved');
      return i;
    }
  }
  return yt;
}
