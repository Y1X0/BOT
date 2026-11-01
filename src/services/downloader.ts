import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { env } from '../config/env';
import { getYtdlpPath } from './ytdlp-updater';
import { createLogger } from '../core/logger';
import { cobaltConfigured, cobaltDownload } from './cobalt';

const log = createLogger('downloader');

// Resolve a cookies file once. DL_COOKIES points at a file; DL_COOKIES_CONTENT
// carries the cookies.txt content directly (written to a temp file). Passed to
// yt-dlp so login-gated sites (Instagram, private posts) work. yt-dlp scopes each
// cookie to its own domain, so it's safe to attach for every download.
let _cookieFile: string | null | undefined;
function cookieArgs(): string[] {
  if (_cookieFile === undefined) {
    _cookieFile = null;
    try {
      if (env.DL_COOKIES && existsSync(env.DL_COOKIES)) _cookieFile = env.DL_COOKIES;
      else if (env.DL_COOKIES_CONTENT && env.DL_COOKIES_CONTENT.trim()) {
        const p = join(tmpdir(), 'dl-cookies.txt');
        writeFileSync(p, env.DL_COOKIES_CONTENT, 'utf8');
        _cookieFile = p;
        log.info('using download cookies from DL_COOKIES_CONTENT');
      }
    } catch (err) {
      log.warn({ err }, 'failed to prepare download cookies');
      _cookieFile = null;
    }
  }
  return _cookieFile ? ['--cookies', _cookieFile] : [];
}

/**
 * Proof-of-origin (PO) token wiring. When POT_PROVIDER_URL is set, tell the
 * standalone yt-dlp binary where the bgutil plugin lives (--plugin-dirs) and
 * which provider to call (--extractor-args). This passes YouTube's "Sign in to
 * confirm you're not a bot" wall WITHOUT cookies. No-op when unset.
 */
function potBaseUrl(): string | null {
  const url = env.POT_PROVIDER_URL?.trim().replace(/\/+$/, '');
  return url ? url : null;
}
function potArgs(): string[] {
  const url = potBaseUrl();
  if (!url) return [];
  return [
    '--plugin-dirs',
    env.POT_PLUGIN_DIRS,
    '--plugin-dirs',
    'default',
    '--extractor-args',
    `youtubepot-bgutilhttp:base_url=${url}`,
  ];
}

/**
 * Wake the PO-token service before downloading. It runs on Render's free tier,
 * which spins the service down after ~15 min idle (≈50s cold start). Pinging it
 * first means yt-dlp's token request doesn't hit a sleeping server and fail.
 * Best-effort and bounded; cached for 5 min so back-to-back downloads skip it.
 */
let _potWarmedAt = 0;
async function warmPotProvider(): Promise<void> {
  const url = potBaseUrl();
  if (!url) return;
  if (Date.now() - _potWarmedAt < 5 * 60_000) return; // still warm
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${url}/ping`, { signal: controller.signal }).finally(() =>
        clearTimeout(t),
      );
      if (res.ok) {
        _potWarmedAt = Date.now();
        log.info('PO-token provider is awake');
        return;
      }
    } catch {
      /* cold/booting — retry */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log.warn('PO-token provider did not wake in time; downloading without a PO token');
}

const TIMEOUT_MS = 300_000; // 5 min
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv'];

export type DlError = 'notinstalled' | 'unsupported' | 'toolarge' | 'private' | 'botwall' | 'failed' | 'timeout';

export interface DlResult {
  filePath: string;
  title: string;
  isVideo: boolean;
  cleanup: () => Promise<void>;
}

/** Short, user-safe reason pulled from yt-dlp's ERROR line (for diagnostics). */
function extractReason(stderr: string): string | undefined {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /error/i.test(l))
    .pop();
  if (!line) return undefined;
  return line.replace(/^ERROR:\s*/i, '').slice(0, 180);
}

/**
 * Download a video/media file from any yt-dlp-supported URL (TikTok, Instagram
 * Reels, X/Twitter, Facebook, etc.). Fixed argv — no shell. Never throws.
 */
export type DlMode = 'video' | 'audio';

export async function downloadVideo(
  url: string,
): Promise<DlResult | { error: DlError; reason?: string }> {
  return downloadMedia(url, 'video');
}

export async function downloadAudio(
  url: string,
): Promise<DlResult | { error: DlError; reason?: string }> {
  return downloadMedia(url, 'audio');
}

async function downloadMedia(
  url: string,
  mode: DlMode,
): Promise<DlResult | { error: DlError; reason?: string }> {
  // When a (self-hosted) Cobalt instance is configured, prefer it: the heavy
  // download/mux happens on Cobalt's server, so this memory-limited host never
  // runs yt-dlp for big media and can't OOM mid-download. Also, Cobalt fetches
  // from its own IP, so it can succeed where ours is blocked. Fall back to local
  // yt-dlp only if Cobalt can't handle the link.
  if (cobaltConfigured()) {
    const c = await cobaltDownload(url, mode === 'audio');
    if (!('error' in c)) {
      const isVideo = mode === 'video' && VIDEO_EXTS.includes(extname(c.filePath).toLowerCase());
      log.info({ mode }, 'link download resolved via cobalt (primary)');
      return { filePath: c.filePath, title: c.title, isVideo, cleanup: c.cleanup };
    }
    log.warn({ err: c.error }, 'cobalt failed; falling back to local yt-dlp');
  }
  return ytDlpDownload(url, mode);
}

async function ytDlpDownload(
  url: string,
  mode: DlMode,
): Promise<DlResult | { error: DlError; reason?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dl-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const maxMb = env.DL_MAX_SIZE_MB > 0 ? env.DL_MAX_SIZE_MB : 50;

  // Wake the PO-token provider (no-op unless POT_PROVIDER_URL is set).
  await warmPotProvider();

  // Keep the memory/size footprint low on the 512MB host: 128k audio, 360p video.
  const formatArgs =
    mode === 'audio'
      ? ['-x', '--audio-format', 'mp3', '--audio-quality', '5']
      : ['-S', 'res:360,ext:mp4:m4a,br', '--merge-output-format', 'mp4'];

  const args = [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--geo-bypass',
    ...cookieArgs(),
    ...potArgs(),
    ...(env.YT_PROXY ? ['--proxy', env.YT_PROXY] : env.YT_FORCE_IPV4 ? ['--force-ipv4'] : []),
    '--max-filesize',
    `${maxMb}M`,
    ...formatArgs,
    '-o',
    `${join(dir, 'media')}.%(ext)s`,
    // Print the title but DON'T switch to simulate mode (--print implies it).
    '--print',
    'after_move:%(title)s',
    '--no-simulate',
    url,
  ];

  return new Promise<DlResult | { error: DlError; reason?: string }>((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: DlResult | { error: DlError; reason?: string }) => {
      if (done) return;
      done = true;
      resolve(r);
    };

    const child = spawn(getYtdlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', async (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      await cleanup();
      finish({ error: err.code === 'ENOENT' ? 'notinstalled' : 'failed' });
    });
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', async (code) => {
      clearTimeout(timer);
      const title = stdout.trim().split('\n').filter(Boolean).pop() ?? 'media';
      try {
        const files = (await readdir(dir)).filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
        // Pick the largest produced file.
        let best: { path: string; size: number } | null = null;
        for (const f of files) {
          const p = join(dir, f);
          const s = await stat(p).catch(() => null);
          if (s?.isFile() && (!best || s.size > best.size)) best = { path: p, size: s.size };
        }
        if (best && best.size > 0) {
          const isVideo = VIDEO_EXTS.includes(extname(best.path).toLowerCase());
          finish({ filePath: best.path, title, isVideo, cleanup });
          return;
        }
      } catch {
        /* fall through */
      }
      await cleanup();
      log.warn({ code, stderr: stderr.slice(-400) }, 'download produced no file');
      const reason = extractReason(stderr);
      if (code === null) finish({ error: 'timeout' });
      else if (/max-filesize|larger than/i.test(stderr)) finish({ error: 'toolarge' });
      else if (/sign in to confirm|not a bot|confirm you.?re not a bot/i.test(stderr))
        finish({ error: 'botwall', reason });
      else if (/login required|login to|private|not available|age-restricted|rate-limit/i.test(stderr))
        finish({ error: 'private', reason });
      else if (/Unsupported URL|is not a valid URL/i.test(stderr)) finish({ error: 'unsupported', reason });
      else finish({ error: 'failed', reason });
    });
  });
}
