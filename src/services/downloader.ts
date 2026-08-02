import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { env } from '../config/env';
import { createLogger } from '../core/logger';
import { cobaltConfigured, cobaltDownload } from './cobalt';

const log = createLogger('downloader');

const TIMEOUT_MS = 300_000; // 5 min
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv'];

export type DlError = 'notinstalled' | 'unsupported' | 'toolarge' | 'private' | 'failed' | 'timeout';

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
export async function downloadVideo(
  url: string,
): Promise<DlResult | { error: DlError; reason?: string }> {
  const primary = await ytDlpDownloadVideo(url);
  if (!('error' in primary)) return primary;
  // Fallback to a (self-hosted) Cobalt instance for block-like failures — it
  // downloads from its own IP, so it can succeed where our IP is blocked.
  if (cobaltConfigured() && ['failed', 'private', 'timeout'].includes(primary.error)) {
    const c = await cobaltDownload(url, false);
    if (!('error' in c)) {
      const isVideo = VIDEO_EXTS.includes(extname(c.filePath).toLowerCase());
      log.info('link download resolved via cobalt');
      return { filePath: c.filePath, title: c.title, isVideo, cleanup: c.cleanup };
    }
  }
  return primary;
}

async function ytDlpDownloadVideo(
  url: string,
): Promise<DlResult | { error: DlError; reason?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dl-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const maxMb = env.DL_MAX_SIZE_MB > 0 ? env.DL_MAX_SIZE_MB : 50;

  const args = [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--geo-bypass',
    ...(env.YT_PROXY ? ['--proxy', env.YT_PROXY] : env.YT_FORCE_IPV4 ? ['--force-ipv4'] : []),
    '--max-filesize',
    `${maxMb}M`,
    // Prefer ≤720p mp4 to keep files under Telegram's limit; accept any format.
    '-S',
    'res:720,ext:mp4:m4a,br',
    '--merge-output-format',
    'mp4',
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

    const child = spawn(env.YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      else if (/login required|login to|private|not available|age-restricted|rate-limit/i.test(stderr))
        finish({ error: 'private', reason });
      else if (/Unsupported URL|is not a valid URL/i.test(stderr)) finish({ error: 'unsupported', reason });
      else finish({ error: 'failed', reason });
    });
  });
}
