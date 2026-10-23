import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '../../core/logger';

const log = createLogger('youtube:media');

/** Host of a URL, for redacted diagnostics (never log the full signed URL). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

/** Shared helpers for the Piped/Invidious HTTP extraction engines. */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export async function fetchJson(
  url: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | Array<unknown> | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  const host = hostOf(url);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok) {
      log.warn({ host, status: r.status }, 'fetchJson non-ok');
      return null;
    }
    return (await r.json()) as Record<string, unknown> | Array<unknown>;
  } catch (err) {
    log.warn({ host, err: String(err).slice(0, 80) }, 'fetchJson error (timeout/network)');
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Stream a URL to a local file. Returns the number of BYTES written (0 on any
 * failure — still falsy, so `if (!await downloadTo(...))` keeps working). Logs a
 * redacted diagnostic (host + HTTP status + bytes) so we can tell a provider-
 * proxied stream from a direct googlevideo URL that the datacenter IP blocks.
 */
export async function downloadTo(url: string, dest: string, timeoutMs = 120_000): Promise<number> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  const host = hostOf(url);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok || !r.body) {
      log.warn({ host, status: r.status }, 'media fetch not-ok');
      return 0;
    }
    await pipeline(
      Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest),
    );
    const bytes = await stat(dest).then((s) => s.size).catch(() => 0);
    log.info({ host, status: r.status, bytes }, 'media fetch ok');
    return bytes;
  } catch (err) {
    log.warn({ host, err: String(err).slice(0, 80) }, 'media fetch error (timeout/network)');
    return 0;
  } finally {
    clearTimeout(t);
  }
}

/** Transcode any audio file to MP3 with ffmpeg. Returns false on failure. */
export function ffmpegToMp3(input: string, output: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-y', '-i', input, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', output], {
      stdio: 'ignore',
    });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}
