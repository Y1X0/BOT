import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/env';
import { createLogger } from '../../core/logger';
import { youtubeConfig } from './config';

const log = createLogger('youtube:ytdlp');

/** Resolve a cookies file once: from YT_COOKIES content or YT_COOKIES_FILE path. */
let cookiesPath: string | null | undefined;
function getCookiesPath(): string | null {
  if (cookiesPath !== undefined) return cookiesPath;
  cookiesPath = null;
  try {
    const raw = env.YT_COOKIES?.trim();
    if (raw) {
      let content = raw;
      // Accept either raw cookies.txt or a Base64 blob (single-line, robust in
      // env vars). Detect Base64: only base64 chars, no tabs, no "youtube".
      const looksBase64 =
        /^[A-Za-z0-9+/=\s]+$/.test(raw) && !raw.includes('\t') && !/youtube/i.test(raw);
      if (looksBase64) {
        content = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
      } else {
        content = raw.replace(/\\n/g, '\n'); // literal "\n" → real newlines
      }
      const p = join(tmpdir(), 'yt-cookies.txt');
      writeFileSync(p, content, 'utf8');
      cookiesPath = p;
      log.info('Using YouTube cookies from YT_COOKIES');
    } else if (env.YT_COOKIES_FILE && existsSync(env.YT_COOKIES_FILE)) {
      cookiesPath = env.YT_COOKIES_FILE;
    }
  } catch (err) {
    log.warn({ err }, 'Failed to prepare cookies file');
    cookiesPath = null;
  }
  return cookiesPath;
}

/** Args applied to every yt-dlp call to improve reliability on server IPs. */
function commonArgs(): string[] {
  const a = ['--no-warnings', '--geo-bypass'];
  if (env.YT_FORCE_IPV4 && !env.YT_PROXY) a.push('--force-ipv4');
  if (env.YT_PROXY) a.push('--proxy', env.YT_PROXY);
  const cp = getCookiesPath();
  if (cp) a.push('--cookies', cp);
  if (env.YT_PLAYER_CLIENT) a.push('--extractor-args', `youtube:player_client=${env.YT_PLAYER_CLIENT}`);
  return a;
}

const SEARCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000; // 10 min — long videos allowed

export interface SearchItem {
  videoId: string;
  title: string;
  duration: number | null; // seconds
}

export type YtError = 'notinstalled' | 'notfound' | 'toolarge' | 'blocked' | 'failed' | 'timeout';

export interface DownloadResult {
  filePath: string;
  title: string;
  cleanup: () => Promise<void>;
}

/** Run yt-dlp with a fixed argv (no shell → query can't inject commands). */
function run(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const child = spawn(env.YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (!done) child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (spawnError: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError });
    });
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function classifyError(stderr: string): YtError {
  if (/max-filesize|too large|file is larger/i.test(stderr)) return 'toolarge';
  if (/sign in|confirm you'?re not a bot|HTTP Error 429|blocked|not a bot/i.test(stderr))
    return 'blocked';
  return 'failed';
}

/**
 * Search YouTube and return up to `limit` results (id, title, duration).
 * Uses a flat, download-free query so it stays fast.
 */
export async function search(query: string, limit: number): Promise<SearchItem[] | { error: YtError }> {
  const args = [
    ...commonArgs(),
    '--no-playlist',
    '--flat-playlist',
    '--skip-download',
    '--print',
    '%(id)s\t%(title)s\t%(duration)s',
    `ytsearch${limit}:${query}`,
  ];
  const { code, stdout, stderr, spawnError } = await run(args, SEARCH_TIMEOUT_MS);
  if (spawnError) return { error: spawnError.code === 'ENOENT' ? 'notinstalled' : 'failed' };

  const items: SearchItem[] = [];
  for (const line of stdout.split('\n')) {
    const [videoId, title, dur] = line.split('\t');
    if (videoId && title) {
      const duration = dur && /^\d+(\.\d+)?$/.test(dur) ? Math.round(Number(dur)) : null;
      items.push({ videoId, title, duration });
    }
  }
  if (items.length) return items;
  if (code !== 0) {
    log.warn({ code, stderr: stderr.slice(-300) }, 'search failed');
    return { error: classifyError(stderr) };
  }
  return { error: 'notfound' };
}

/**
 * Download a video's audio as MP3. Applies duration/size caps only if they are
 * configured (null = unlimited). Never throws; returns a result or an error.
 */
export async function downloadAudio(
  videoId: string,
): Promise<DownloadResult | { error: YtError }> {
  const dir = await mkdtemp(join(tmpdir(), 'yt-'));
  const outBase = join(dir, 'audio');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);

  const args = [
    ...commonArgs(),
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '--no-playlist',
    '-o',
    `${outBase}.%(ext)s`,
    '--print',
    '%(title)s',
    '--no-progress',
  ];
  if (youtubeConfig.maxDuration != null) {
    args.push('--match-filter', `duration <= ${youtubeConfig.maxDuration}`);
  }
  if (youtubeConfig.maxSize != null) {
    args.push('--max-filesize', String(youtubeConfig.maxSize));
  }
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  const { code, stdout, stderr, spawnError } = await run(args, DOWNLOAD_TIMEOUT_MS);
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
    /* no file produced */
  }
  await cleanup();
  log.warn({ code, stderr: stderr.slice(-400) }, 'download produced no file');
  if (code === null) return { error: 'timeout' };
  return { error: code === 0 ? 'notfound' : classifyError(stderr) };
}
