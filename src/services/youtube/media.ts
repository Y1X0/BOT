import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Shared helpers for the Piped/Invidious HTTP extraction engines. */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export async function fetchJson(
  url: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | Array<unknown> | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown> | Array<unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Stream a URL to a local file. Returns false on any failure. */
export async function downloadTo(url: string, dest: string, timeoutMs = 120_000): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok || !r.body) return false;
    await pipeline(
      Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest),
    );
    return true;
  } catch {
    return false;
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
