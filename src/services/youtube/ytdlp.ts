import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/env';
import { getYtdlpPath } from '../ytdlp-updater';
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

/**
 * Player clients tried in order until one yields a downloadable file.
 * Some clients (notably `tv`/`web`) return DRM-protected formats that can't be
 * saved, while mobile clients (`android`, `ios`, `mweb`) return normal audio —
 * so those go first. `tv` is last (it caused "DRM protected" failures).
 * No cookies required; cookies (if set) attach to every attempt.
 */
// Trimmed to the clients that actually yield downloadable audio, best-first.
// Each extra client is a full failed round-trip when YouTube blocks the IP, so
// fewer = faster failure to a working method. The mobile clients return normal
// (non-DRM) audio; tv/web mostly returned DRM-protected formats we can't save.
// With WARP egress unblocking YouTube, the `web` client becomes viable again
// (its nsig JS challenge is solved by the bundled Deno), and it returns proper
// audio-only DASH formats — so it's a strong fallback after the mobile clients.
const CLIENT_FALLBACKS = [
  'android',
  'ios',
  'web',
  'tv_embedded',
];

/** The ordered list of player clients to attempt for this environment. */
function clientsToTry(): (string | null)[] {
  if (env.YT_PLAYER_CLIENT) return [env.YT_PLAYER_CLIENT]; // explicit override wins
  return CLIENT_FALLBACKS; // cookies (if any) are attached to every attempt
}

/**
 * Args applied to every yt-dlp call. `client` null = no player_client override.
 * `useProxy` routes the call through WARP (YT_PROXY) — only DOWNLOAD needs it,
 * since that's the part YouTube blocks on our datacenter IP. SEARCH skips the
 * tunnel so it stays fast and isn't limited by WARP's throughput ceiling.
 */
function commonArgs(client: string | null, useProxy = false): string[] {
  // --socket-timeout: fail a stalled connection fast instead of hanging, so a
  // blocked attempt moves on to the next method quickly (key on datacenter IPs).
  const a = ['--no-warnings', '--geo-bypass', '--socket-timeout', '20'];
  const proxy = useProxy ? env.YT_PROXY : undefined;
  if (env.YT_FORCE_IPV4 && !proxy) a.push('--force-ipv4');
  if (proxy) a.push('--proxy', proxy);
  const cp = getCookiesPath();
  if (cp) a.push('--cookies', cp);
  if (client) a.push('--extractor-args', `youtube:player_client=${client}`);
  return a;
}

/** Errors worth retrying with a different player client. */
function isRetryable(e: YtError): boolean {
  return e === 'blocked' || e === 'failed' || e === 'drm';
}

// Keep search snappy: a flat ytsearch returns in ~2-3s, so cap each attempt low
// and fail fast to the fallback instead of making the user wait.
const SEARCH_TIMEOUT_MS = 8_000;
// Per-attempt cap. Audio files are small, but routing through the WARP tunnel
// adds latency and audio extraction costs a little CPU on the 0.1-vCPU tier, so
// give each attempt enough room to finish a real song without timing out.
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 150_000;

export interface SearchItem {
  videoId: string;
  title: string;
  duration: number | null; // seconds
}

export type YtError =
  | 'notinstalled'
  | 'notfound'
  | 'toolarge'
  | 'blocked'
  | 'failed'
  | 'timeout'
  | 'drm';

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
    const child = spawn(getYtdlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (/DRM protected|drm/i.test(stderr)) return 'drm';
  if (/sign in|confirm you'?re not a bot|HTTP Error 429|blocked|not a bot/i.test(stderr))
    return 'blocked';
  return 'failed';
}

/**
 * Clients to try FOR SEARCH. SPEED-first: `android` answers a flat ytsearch in a
 * couple of seconds and rarely blocks, so it goes first and almost always
 * returns on the first try. `null` (default web) is a single relevance fallback
 * only if android somehow yields nothing. Kept short so search feels instant.
 */
function searchClients(): (string | null)[] {
  if (env.YT_PLAYER_CLIENT) return [env.YT_PLAYER_CLIENT];
  return ['android', null];
}

/**
 * Search YouTube and return up to `limit` results (id, title, duration).
 * Uses a flat, download-free query so it stays fast.
 */
export async function search(query: string, limit: number): Promise<SearchItem[] | { error: YtError }> {
  let lastError: YtError = 'failed';
  for (const client of searchClients()) {
    const args = [
      ...commonArgs(client),
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
    if (items.length) {
      log.info({ client: client ?? 'default', count: items.length }, 'search succeeded');
      return items;
    }

    lastError = code === 0 ? 'notfound' : classifyError(stderr);
    log.warn({ code, client, stderr: stderr.slice(-200) }, 'search attempt failed');
    if (!isRetryable(lastError)) break;
  }
  return { error: lastError };
}

/**
 * Download a video's audio as MP3. Applies duration/size caps only if they are
 * configured (null = unlimited). Never throws; returns a result or an error.
 */
export interface DownloadOpts {
  /** Prefer a smaller (lower-bitrate) native audio stream — for long tracks,
   *  so the file downloads and uploads to Telegram much faster. */
  lowBitrate?: boolean;
}

export async function downloadAudio(
  videoId: string,
  opts: DownloadOpts = {},
): Promise<DownloadResult | { error: YtError }> {
  let lastError: YtError = 'failed';
  for (const client of clientsToTry()) {
    const result = await attemptDownload(videoId, client, opts.lowBitrate ?? false);
    if ('filePath' in result) {
      log.info({ client: client ?? 'default' }, 'download succeeded (extractor)');
      return result;
    }
    lastError = result.error;
    log.warn({ client, error: lastError }, 'download attempt failed');
    if (!isRetryable(lastError)) break;
  }
  return { error: lastError };
}

/** A single download attempt with one player client. Cleans up on failure. */
async function attemptDownload(
  videoId: string,
  client: string | null,
  lowBitrate: boolean,
): Promise<DownloadResult | { error: YtError }> {
  const dir = await mkdtemp(join(tmpdir(), 'yt-'));
  const outBase = join(dir, 'audio');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);

  // Prefer a small audio-only stream, but ALWAYS fall back to `best` so we never
  // hit "Requested format is not available" when a client only offers combined
  // (progressive video+audio) formats — common with the android/ios clients.
  // `--extract-audio` (below) then pulls the audio track out of whatever we got.
  const format = lowBitrate
    ? 'bestaudio[ext=m4a][abr<=70]/worstaudio[ext=m4a]/bestaudio/best'
    : 'bestaudio[ext=m4a]/bestaudio/best';

  const args = [
    ...commonArgs(client, true), // download goes through WARP (YT_PROXY)
    '-f',
    format,
    // Extract the audio track from whatever stream we got (audio-only DASH or a
    // combined/progressive file). `best` keeps the original codec (remux, no
    // re-encode) when possible, so it stays fast and lossless.
    '--extract-audio',
    '--audio-format',
    'best',
    '--concurrent-fragments',
    '4',
    '--no-playlist',
    '-o',
    `${outBase}.%(ext)s`,
    // Print the title but keep downloading (--print alone implies --simulate).
    '--print',
    'after_move:%(title)s',
    '--no-simulate',
    '--no-progress',
    // Fail a blocked/broken extraction fast instead of retrying for a long time.
    '--retries',
    '3',
    '--extractor-retries',
    '1',
  ];
  if (youtubeConfig.maxDuration != null) {
    args.push('--match-filter', `duration <= ${youtubeConfig.maxDuration}`);
  }
  if (youtubeConfig.maxSize != null) {
    args.push('--max-filesize', String(youtubeConfig.maxSize));
  }
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  const { code, stdout, stderr, spawnError } = await run(args, DOWNLOAD_ATTEMPT_TIMEOUT_MS);
  if (spawnError) {
    await cleanup();
    return { error: spawnError.code === 'ENOENT' ? 'notinstalled' : 'failed' };
  }

  const title = stdout.trim().split('\n').filter(Boolean).pop() ?? 'audio';
  // The container extension now varies (m4a/webm/opus) since we no longer force
  // mp3, so find the produced file instead of assuming a fixed extension.
  try {
    const files = await readdir(dir);
    const name = files.find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
    if (name) {
      const filePath = join(dir, name);
      const s = await stat(filePath);
      if (s.size > 0) return { filePath, title, cleanup };
    }
  } catch {
    /* no file produced */
  }
  await cleanup();
  log.warn({ code, client, stderr: stderr.slice(-300) }, 'attempt produced no file');
  if (code === null) return { error: 'timeout' };
  return { error: code === 0 ? 'notfound' : classifyError(stderr) };
}
