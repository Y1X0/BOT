import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env';
import { createLogger } from '../core/logger';
import { downloadTo } from './youtube/media';
import type { DownloadResult, YtError } from './youtube/ytdlp';

const log = createLogger('cobalt');

export function cobaltConfigured(): boolean {
  return Boolean(env.COBALT_API_URL);
}

interface CobaltResponse {
  status?: string; // tunnel | redirect | stream | picker | error
  url?: string;
  filename?: string;
  picker?: Array<{ url?: string }>;
  error?: { code?: string };
}

function sanitize(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 120) || 'media';
}

/**
 * Ask a (self-hosted) Cobalt instance to resolve a media URL, then stream the
 * file locally. Because Cobalt talks to YouTube from ITS OWN IP, this works
 * even when this server's IP is blocked. `audio` = extract MP3 audio only.
 */
export async function cobaltDownload(sourceUrl: string, audio: boolean): Promise<DownloadResult | { error: YtError }> {
  const base = env.COBALT_API_URL;
  if (!base) return { error: 'failed' };

  let data: CobaltResponse | null = null;
  try {
    const res = await fetch(base.replace(/\/+$/, '') + '/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(env.COBALT_API_KEY ? { authorization: `Api-Key ${env.COBALT_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        url: sourceUrl,
        downloadMode: audio ? 'audio' : 'auto',
        audioFormat: 'mp3',
        filenameStyle: 'basic',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    data = (await res.json()) as CobaltResponse;
  } catch (err) {
    log.warn({ err }, 'cobalt request failed');
    return { error: 'failed' };
  }

  const downloadUrl = data?.url ?? data?.picker?.find((p) => p.url)?.url;
  if (!downloadUrl || data?.status === 'error') {
    log.warn({ status: data?.status, code: data?.error?.code }, 'cobalt returned no url');
    return { error: 'failed' };
  }

  const dir = await mkdtemp(join(tmpdir(), 'cbl-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const filename = sanitize(data?.filename ?? (audio ? 'audio.mp3' : 'media.mp4'));
  const filePath = join(dir, filename);

  const ok = await downloadTo(downloadUrl, filePath, 300_000);
  if (!ok) {
    await cleanup();
    return { error: 'failed' };
  }
  try {
    const s = await stat(filePath);
    if (s.size > 0) {
      const title = filename.replace(/\.[^.]+$/, '');
      return { filePath, title, cleanup };
    }
  } catch {
    /* no file */
  }
  await cleanup();
  return { error: 'failed' };
}
