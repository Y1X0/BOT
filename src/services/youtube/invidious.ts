import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/env';
import { createLogger } from '../../core/logger';
import { fetchJson, downloadTo, ffmpegToMp3 } from './media';
import type { DownloadResult, SearchItem, YtError } from './ytdlp';

const log = createLogger('youtube:invidious');

/**
 * Extraction via public Invidious instances — a second, independent network to
 * Piped. `local=true` proxies media through the instance so downloads don't hit
 * googlevideo from our (blocked) IP.
 */
const DEFAULT_INSTANCES = [
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://invidious.jing.rocks',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
  'https://iv.melmac.space',
  'https://invidious.f5.si',
];

function instances(): string[] {
  if (env.YT_INVIDIOUS_INSTANCES) {
    return env.YT_INVIDIOUS_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_INSTANCES;
}

export async function invidiousSearch(
  query: string,
  limit: number,
): Promise<SearchItem[] | { error: YtError }> {
  for (const base of instances()) {
    const data = (await fetchJson(
      `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
    )) as Array<Record<string, unknown>> | null;
    if (!Array.isArray(data)) continue;

    const items: SearchItem[] = [];
    for (const it of data) {
      const videoId = it.videoId ? String(it.videoId) : '';
      const title = it.title ? String(it.title) : '';
      if (videoId && title) {
        const dur = typeof it.lengthSeconds === 'number' && it.lengthSeconds > 0 ? it.lengthSeconds : null;
        items.push({ videoId, title, duration: dur });
      }
      if (items.length >= limit) break;
    }
    if (items.length) {
      log.info({ base, count: items.length }, 'invidious search ok');
      return items;
    }
  }
  return { error: 'failed' };
}

interface AdaptiveFormat {
  url?: string;
  type?: string; // e.g. "audio/mp4; codecs=..."
  bitrate?: string | number;
}

export async function invidiousDownload(
  videoId: string,
): Promise<DownloadResult | { error: YtError }> {
  for (const base of instances()) {
    const data = (await fetchJson(`${base}/api/v1/videos/${videoId}?local=true`)) as
      | { title?: string; adaptiveFormats?: AdaptiveFormat[] }
      | null;
    const audio = (data?.adaptiveFormats ?? []).filter((f) => /^audio\//i.test(f.type ?? ''));
    if (!audio.length) continue;

    const sorted = [...audio].sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));
    const chosen = sorted.find((f) => /mp4/i.test(f.type ?? '')) ?? sorted[0];
    if (!chosen?.url) continue;

    const title = data?.title ? String(data.title) : 'audio';
    const isMp4 = /mp4/i.test(chosen.type ?? '');
    const dir = await mkdtemp(join(tmpdir(), 'inv-'));
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
        log.info({ base }, 'invidious download ok');
        return { filePath, title, cleanup };
      }
      await cleanup();
    } catch (err) {
      log.warn({ err, base }, 'invidious download error');
      await cleanup();
    }
  }
  return { error: 'blocked' };
}
