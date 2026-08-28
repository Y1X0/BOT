import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getYtdlpPath } from './ytdlp-updater';
import { createLogger } from '../core/logger';

const log = createLogger('soundcloud');

export interface ScItem {
  url: string;
  title: string;
  duration: number | null; // seconds
}
export type ScError = 'notinstalled' | 'notfound' | 'timeout' | 'toolarge' | 'failed';
export interface ScDownload {
  filePath: string;
  title: string;
  cleanup: () => Promise<void>;
}

function run(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const p = spawn(getYtdlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      p.kill('SIGKILL');
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: e });
    });
    p.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parse yt-dlp's tab-separated "url\ttitle\tduration" lines. Pure/testable. */
export function parseScResults(stdout: string): ScItem[] {
  const items: ScItem[] = [];
  for (const line of stdout.split('\n')) {
    const [url, title, dur] = line.split('\t');
    if (url?.startsWith('http') && title) {
      const duration = dur && /^\d+(\.\d+)?$/.test(dur) ? Math.round(Number(dur)) : null;
      items.push({ url, title, duration });
    }
  }
  return items;
}

/** Search SoundCloud for up to `limit` tracks. */
export async function scSearch(query: string, limit = 5): Promise<ScItem[] | { error: ScError }> {
  const args = [
    '--no-warnings',
    '--skip-download',
    '--print',
    '%(webpage_url)s\t%(title)s\t%(duration)s',
    `scsearch${limit}:${query}`,
  ];
  const { code, stdout, stderr, spawnError } = await run(args, 30_000);
  if (spawnError) return { error: spawnError.code === 'ENOENT' ? 'notinstalled' : 'failed' };
  const items = parseScResults(stdout);
  if (items.length) return items;
  log.warn({ code, stderr: stderr.slice(-200) }, 'soundcloud search empty');
  return { error: code === 0 ? 'notfound' : 'failed' };
}

/** Download a SoundCloud track (by its URL) as MP3. */
export async function scDownload(url: string): Promise<ScDownload | { error: ScError }> {
  if (!url.startsWith('http')) return { error: 'failed' };
  const dir = await mkdtemp(join(tmpdir(), 'sc-'));
  const outBase = join(dir, 'audio');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const args = [
    '--no-warnings',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '--no-playlist',
    '-o',
    `${outBase}.%(ext)s`,
    '--print',
    'after_move:%(title)s',
    '--no-simulate',
    '--no-progress',
    url,
  ];
  const { code, stdout, stderr, spawnError } = await run(args, 300_000);
  if (spawnError) {
    await cleanup();
    return { error: spawnError.code === 'ENOENT' ? 'notinstalled' : 'failed' };
  }
  const title = stdout.trim().split('\n').filter(Boolean).pop() ?? 'audio';
  const filePath = `${outBase}.mp3`;
  try {
    const s = await stat(filePath);
    if (s.size > 0) return { filePath, title, cleanup };
  } catch {
    /* no file */
  }
  await cleanup();
  log.warn({ code, stderr: stderr.slice(-300) }, 'soundcloud download produced no file');
  return { error: code === null ? 'timeout' : 'failed' };
}
