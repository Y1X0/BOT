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
    // Force the web-family clients. yt-dlp only requests a PO token for WEBPO
    // clients; its default set (tv/ios) never asks the provider, so it bot-walls
    // at the player stage before any token is fetched. These clients fetch the
    // token from bgutil and pass the "not a bot" check. The bot has deno+node
    // for the JS challenge these clients need.
    '--extractor-args',
    'youtube:player_client=web,web_safari,mweb',
  ];
}

/** Pull the lines of a verbose yt-dlp run that explain a PO-token/YouTube
 *  failure, so the server log shows what actually happened. */
function diagLines(stderr: string): string {
  const re = /pot|bgutil|token|player.?client|GetPOT|challenge|jsc|visitor|sign in|not a bot|nsig|HTTP Error|forbidden|provider/i;
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l && re.test(l));
  return (lines.length ? lines : stderr.split('\n').filter(Boolean)).slice(-30).join('\n');
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
  // The provider is a heavy image (canvas/jsdom) on a 0.1-CPU free instance, so
  // a cold start from hibernation can take ~1-2 min. CRITICAL: use a LONG
  // per-request timeout. When the free service is asleep, Render holds the
  // request open through the whole spin-up and returns once it's up — a short
  // timeout aborts mid-wake and cancels the spin-up, so it never boots.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const res = await fetch(`${url}/ping`, {
        signal: AbortSignal.timeout(Math.min(remaining, 120_000)),
      });
      if (res.ok) {
        _potWarmedAt = Date.now();
        log.info('PO-token provider is awake');
        return;
      }
      // 5xx while spinning up — wait briefly and re-hold.
    } catch {
      /* boot still in progress / timed out — retry */
    }
    if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
  }
  log.warn('PO-token provider did not wake in time; downloading without a PO token');
}

const TIMEOUT_MS = 900_000; // 15 min — long podcasts through WARP download + re-encode slowly on 0.1 CPU
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

/** yt-dlp args shared by the duration probe and the real download (proxy,
 *  YouTube client, cookies), so the probe sees YouTube exactly as the download. */
function sharedYtArgs(): string[] {
  return [
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    ...cookieArgs(),
    ...potArgs(),
    ...(potBaseUrl() ? [] : ['--extractor-args', 'youtube:player_client=android,tv,web']),
    ...(env.YT_PROXY ? ['--proxy', env.YT_PROXY] : env.YT_FORCE_IPV4 ? ['--force-ipv4'] : []),
  ];
}

/** Media duration in seconds (or null). Cheap — no download. Used to pick an
 *  audio bitrate that keeps a long podcast under Telegram's 50MB bot limit. */
function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(getYtdlpPath(), [...sharedYtArgs(), '--skip-download', '--print', 'duration', url], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const t = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(t);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(t);
      const n = parseFloat(out.trim().split('\n')[0]);
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

/** Mono MP3 bitrate (kbps) so ~`durationSec` of audio fits in ~45MB, clamped to
 *  a sane range: short clips/songs get up to 128k, long podcasts drop toward
 *  32k (still clear for speech) so a multi-hour episode fits in one file. */
function audioBitrateKbps(durationSec: number | null): number {
  if (!durationSec || durationSec <= 0) return 64; // unknown → fits ~1.5h
  const kbps = Math.floor((45 * 1024 * 1024 * 8) / 1000 / durationSec);
  return Math.min(128, Math.max(32, kbps));
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

  // YouTube's "not a bot" check on the player request is probabilistic on
  // datacenter IPs even with a valid PO token — the same link that 403s now
  // often succeeds on the next try. So when the PO provider is configured,
  // retry a bot-wall up to a few times (the provider is warm, each try is fast).
  // Retry a bot-wall when WARP (or a PO provider) is in play: the block is
  // usually transient there — the same link often succeeds on the next try.
  const maxAttempts = potBaseUrl() || env.YT_PROXY ? 4 : 1;
  // For audio, choose a bitrate from the duration so a long podcast still fits
  // Telegram's 50MB bot limit — probe once, reuse across retries.
  const audioKbps = mode === 'audio' ? audioBitrateKbps(await probeDuration(url)) : undefined;
  let result = await ytDlpDownload(url, mode, audioKbps);
  for (
    let attempt = 2;
    attempt <= maxAttempts && 'error' in result && result.error === 'botwall';
    attempt++
  ) {
    log.info({ attempt }, 'bot-wall — retrying download');
    result = await ytDlpDownload(url, mode, audioKbps);
  }

  // Still bot-walled after retries under WARP: the Cloudflare exit IP got
  // flagged by YouTube. Ask the WARP watchdog to rotate to a fresh IP, give it
  // time to come up, then try once more — so the bot self-heals a flagged IP
  // instead of staying stuck until the next restart.
  if ('error' in result && result.error === 'botwall' && env.YT_PROXY) {
    if (requestWarpRotate()) {
      await new Promise((r) => setTimeout(r, 80_000));
      log.info('retrying download after WARP IP rotation');
      result = await ytDlpDownload(url, mode, audioKbps);
    }
  }
  return result;
}

/** Signal the WARP watchdog (in start.sh) to rotate to a fresh exit IP. Writes
 *  a request file it polls. Best-effort; returns whether the signal was written. */
function requestWarpRotate(): boolean {
  try {
    const dir = process.env.WARP_DIR || '/app/data/warp';
    writeFileSync(join(dir, 'rotate.request'), String(Date.now()), 'utf8');
    log.warn('WARP exit IP bot-walled — requested a WARP IP rotation');
    return true;
  } catch (err) {
    log.warn({ err }, 'failed to request WARP rotation');
    return false;
  }
}

async function ytDlpDownload(
  url: string,
  mode: DlMode,
  audioKbps?: number,
): Promise<DlResult | { error: DlError; reason?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dl-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  // Audio is re-encoded down to fit 50MB (see audioKbps), so allow a large
  // SOURCE download; video is capped at the Telegram limit.
  const maxMb = mode === 'audio' ? 600 : env.DL_MAX_SIZE_MB > 0 ? env.DL_MAX_SIZE_MB : 50;

  // Wake the PO-token provider (no-op unless POT_PROVIDER_URL is set).
  await warmPotProvider();

  // Keep the memory/size footprint low on the 512MB host: 128k audio, ≤480p
  // video. For video, a hard height FILTER (not just a sort) guarantees we
  // never pull a huge high-res format whose size yt-dlp couldn't predict.
  const formatArgs =
    mode === 'audio'
      ? // Audio-only (ba/ba*), re-encoded to a duration-aware mono MP3 bitrate
        // so even a multi-hour podcast fits under Telegram's 50MB bot limit.
        [
          '-f',
          'ba/ba*',
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          `${audioKbps ?? 64}K`,
          '--postprocessor-args',
          'ffmpeg:-ac 1',
        ]
      : [
          '-f',
          'bv*[height<=480]+ba/b[height<=480]/b',
          '-S',
          'res:360,ext:mp4:m4a',
          '--merge-output-format',
          'mp4',
        ];

  const args = [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--geo-bypass',
    ...cookieArgs(),
    ...potArgs(),
    // Force YouTube onto the app clients. yt-dlp's default web clients get
    // bot-walled even through WARP's clean IP, while the `android`/`tv` clients
    // (which WARP's own startup probe uses and confirms pass) don't need a PO
    // token and aren't web-bot-walled. Skip this only when a PO provider is set,
    // since that path (potArgs) selects the web clients on purpose. The
    // `youtube:` prefix makes this a no-op for every other platform.
    ...(potBaseUrl() ? [] : ['--extractor-args', 'youtube:player_client=android,tv,web']),
    ...(env.YT_PROXY ? ['--proxy', env.YT_PROXY] : env.YT_FORCE_IPV4 ? ['--force-ipv4'] : []),
    '--max-filesize',
    `${maxMb}M`,
    // Stream the download to disk in small chunks so a download (especially
    // through the WARP SOCKS proxy) can't balloon memory and OOM the 512MB host.
    '--http-chunk-size',
    '1M',
    '--concurrent-fragments',
    '1',
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
          log.info(
            { mode, isVideo, sizeMB: +(best.size / (1024 * 1024)).toFixed(1), title },
            'download complete',
          );
          finish({ filePath: best.path, title, isVideo, cleanup });
          return;
        }
      } catch {
        /* fall through */
      }
      await cleanup();
      log.warn({ code, diag: diagLines(stderr) }, 'download produced no file');
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
