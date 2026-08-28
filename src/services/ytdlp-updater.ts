import { spawn } from 'node:child_process';
import { mkdir, rename, chmod, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('ytdlp');

// SoundCloud's client_id extraction (and YouTube's) break constantly and are
// only fixed in a recent yt-dlp. On some hosts (e.g. Nixpacks) the packaged
// yt-dlp is months old, so «يوت»/«اغنيه» silently stop working. This keeps a
// fresh nightly binary in a writable cache and points every yt-dlp call at it.

const NIGHTLY_URL = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // refresh at most daily

// The path every service should spawn. Starts at the configured/default binary
// and is swapped to the fresh cached copy once it's verified.
let resolvedPath = env.YTDLP_PATH;
let ensuring: Promise<void> | null = null;

/** The yt-dlp path to spawn (fresh cached nightly when available). */
export function getYtdlpPath(): string {
  return resolvedPath;
}

function version(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    setTimeout(() => {
      p.kill('SIGKILL');
      resolve(null);
    }, 8000);
  });
}

async function pickCacheFile(): Promise<string> {
  // Prefer a project-local cache; fall back to the OS temp dir if not writable.
  for (const dir of [join(process.cwd(), '.cache'), join(tmpdir(), 'botcache')]) {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.wtest'), 'ok');
      return join(dir, 'yt-dlp');
    } catch {
      /* try next */
    }
  }
  return join(tmpdir(), 'yt-dlp');
}

async function download(url: string, dest: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok || !res.body) {
      log.warn({ status: res.status }, 'yt-dlp download failed');
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) {
      log.warn({ size: buf.length }, 'yt-dlp download too small — ignoring');
      return false;
    }
    const tmp = `${dest}.tmp`;
    await writeFile(tmp, buf);
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
    return true;
  } catch (err) {
    log.warn({ err }, 'yt-dlp download error');
    return false;
  }
}

/**
 * Ensure a fresh yt-dlp is available and route every call at it. Best-effort and
 * safe to call repeatedly — never throws. Downloads the latest nightly into a
 * writable cache (at most once a day), verifies it runs, then swaps the path.
 * Falls back to `yt-dlp -U` on the configured binary, then to whatever exists.
 */
export function ensureFreshYtdlp(): Promise<void> {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const dest = await pickCacheFile();

    // Reuse a recent cached copy without re-downloading.
    try {
      const st = await stat(dest);
      if (Date.now() - st.mtimeMs < MAX_AGE_MS && (await version(dest))) {
        resolvedPath = dest;
        log.info({ path: dest }, 'using cached yt-dlp');
        return;
      }
    } catch {
      /* not cached yet */
    }

    if (await download(NIGHTLY_URL, dest)) {
      const v = await version(dest);
      if (v) {
        resolvedPath = dest;
        log.info({ path: dest, version: v }, 'yt-dlp updated to nightly');
        return;
      }
    }

    // Download failed → try to self-update the configured binary in place.
    await new Promise<void>((resolve) => {
      const p = spawn(env.YTDLP_PATH, ['-U'], { stdio: 'ignore' });
      p.on('error', () => resolve());
      p.on('close', () => resolve());
      setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 60_000);
    });
    const cur = await version(env.YTDLP_PATH);
    log.info({ path: env.YTDLP_PATH, version: cur ?? 'unknown' }, 'using configured yt-dlp (no nightly)');
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}
