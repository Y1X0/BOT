import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('youtube');

const TELEGRAM_AUDIO_LIMIT = 50 * 1024 * 1024; // 50 MB bot API limit
const DOWNLOAD_TIMEOUT_MS = 150_000;

export type YtError = 'notinstalled' | 'notfound' | 'toolarge' | 'blocked' | 'failed';

export interface YtSuccess {
  ok: true;
  filePath: string;
  title: string;
  cleanup: () => Promise<void>;
}
export interface YtFailure {
  ok: false;
  error: YtError;
}

/**
 * Search YouTube for `query` and download the top result's audio as MP3.
 * Uses yt-dlp (invoked with a fixed argv — no shell — so the query can't
 * inject commands). Never throws; returns a tagged result.
 */
export async function downloadAudio(query: string): Promise<YtSuccess | YtFailure> {
  const dir = await mkdtemp(join(tmpdir(), 'yt-'));
  const outBase = join(dir, 'audio');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);

  const args = [
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '5',
    '--no-playlist',
    '--max-filesize',
    '48M',
    '--match-filter',
    `duration < ${env.YT_MAX_DURATION_SEC}`,
    '-o',
    `${outBase}.%(ext)s`,
    '--print',
    '%(title)s',
    '--no-warnings',
    '--no-progress',
    `ytsearch1:${query}`,
  ];

  return new Promise<YtSuccess | YtFailure>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: YtSuccess | YtFailure) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const child = spawn(env.YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), DOWNLOAD_TIMEOUT_MS);

    child.on('error', async (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      await cleanup();
      finish({ ok: false, error: err.code === 'ENOENT' ? 'notinstalled' : 'failed' });
    });
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', async (code) => {
      clearTimeout(timer);
      const title = stdout.trim().split('\n').filter(Boolean).pop() ?? query;
      const filePath = `${outBase}.mp3`;
      try {
        const s = await stat(filePath);
        if (s.size > 0 && s.size < TELEGRAM_AUDIO_LIMIT) {
          finish({ ok: true, filePath, title, cleanup });
          return;
        }
        if (s.size >= TELEGRAM_AUDIO_LIMIT) {
          await cleanup();
          finish({ ok: false, error: 'toolarge' });
          return;
        }
      } catch {
        /* no output file */
      }
      await cleanup();
      log.warn({ code, stderr: stderr.slice(-400) }, 'yt-dlp produced no usable file');
      if (/max-filesize|too large/i.test(stderr)) finish({ ok: false, error: 'toolarge' });
      else if (/sign in|confirm you'?re not a bot|HTTP Error 429|blocked/i.test(stderr))
        finish({ ok: false, error: 'blocked' });
      else finish({ ok: false, error: code === 0 ? 'notfound' : 'failed' });
    });
  });
}
