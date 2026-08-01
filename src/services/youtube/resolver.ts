import { env } from '../../config/env';
import { createLogger } from '../../core/logger';
import { search as ytSearch, downloadAudio as ytDownload, type DownloadResult, type SearchItem, type YtError } from './ytdlp';
import { pipedSearch, pipedDownload } from './piped';
import { invidiousSearch, invidiousDownload } from './invidious';

const log = createLogger('youtube:resolver');

export type Engine = 'yt-dlp' | 'piped' | 'invidious';

/**
 * Try each extraction engine in order until one succeeds:
 *   yt-dlp (fast, direct) → Piped → Invidious (HTTP proxies on other IPs).
 * This maximizes the chance of getting audio when the server IP is blocked.
 */
export async function resolveSearch(query: string, limit: number): Promise<SearchItem[] | { error: YtError }> {
  const yt = await ytSearch(query, limit);
  if (!('error' in yt)) return yt;
  if (env.YT_PIPED_ENABLED) {
    const p = await pipedSearch(query, limit);
    if (!('error' in p)) return p;
  }
  if (env.YT_INVIDIOUS_ENABLED) {
    const i = await invidiousSearch(query, limit);
    if (!('error' in i)) return i;
  }
  return yt;
}

export async function resolveDownload(
  videoId: string,
  onEngineTry?: (engine: Engine) => void,
): Promise<DownloadResult | { error: YtError }> {
  onEngineTry?.('yt-dlp');
  const yt = await ytDownload(videoId);
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
