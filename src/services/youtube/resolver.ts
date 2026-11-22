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
  // Try the HTTP engines (fast, run on other IPs, use ~no local CPU). But the
  // public Piped/Invidious instances are frequently ALL dead at once, and each
  // one is tried until it times out — so waiting for them alone made search
  // crawl (and flooded the logs with "fetch failed"). So we ALSO race the
  // reliable yt-dlp flat search, started after a short grace period: a healthy
  // HTTP instance still answers first and yt-dlp never spawns (keeping the
  // 0.1-CPU host free for the download that follows), but when the instances are
  // all down the yt-dlp backstop returns in ~2-3s instead of ~20s of timeouts.
  const attempts: Promise<SearchItem[] | { error: YtError }>[] = [];
  if (env.YT_PIPED_ENABLED) attempts.push(pipedSearch(query, limit));
  if (env.YT_INVIDIOUS_ENABLED) attempts.push(invidiousSearch(query, limit));
  if (!attempts.length) return ytSearch(query, limit);
  // Flat yt-dlp search is light and short-lived; the delay keeps it from
  // spawning when HTTP is healthy. firstSuccess returns as soon as ANY source
  // yields results, so it never waits out the dead instances' timeouts.
  const delayedYt = new Promise<SearchItem[] | { error: YtError }>((resolve) => {
    setTimeout(() => {
      ytSearch(query, limit).then(resolve, () => resolve({ error: 'failed' }));
    }, 2500);
  });
  attempts.push(delayedYt);
  return firstSuccess(attempts);
}

export async function resolveDownload(
  videoId: string,
  onEngineTry?: (engine: Engine) => void,
  opts: { lowBitrate?: boolean } = {},
): Promise<DownloadResult | { error: YtError }> {
  // yt-dlp FIRST now that WARP egress (YT_PROXY) routes it past YouTube's
  // datacenter-IP bot-wall — it's the one path that actually returns audio, and
  // trying it first avoids ~6s wasted on the (currently all-blocked) public
  // instances. Cobalt → Piped → Invidious remain as fallbacks for when WARP is
  // briefly down and a public instance happens to be healthy.
  onEngineTry?.('yt-dlp');
  const yt = await ytDownload(videoId, opts);
  if (!('error' in yt)) {
    log.info({ engine: 'yt-dlp' }, 'download resolved');
    return yt;
  }

  if (cobaltConfigured()) {
    onEngineTry?.('cobalt');
    const c = await cobaltDownload(`https://www.youtube.com/watch?v=${videoId}`, true);
    if (!('error' in c)) {
      log.info({ engine: 'cobalt' }, 'download resolved');
      return c;
    }
  }
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
