import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../core/logger';

const log = createLogger('videosticker');
const MAX_BYTES = 256 * 1024; // Telegram video-sticker limit

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 90_000);
    p.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Convert a video/GIF into a Telegram video sticker: WEBM/VP9, ≤512px, ≤3s,
 * no audio, ≤256KB. Retries at a lower bitrate if the first pass is too big.
 */
export async function videoToSticker(input: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'vstk-'));
  const inp = join(dir, 'in');
  const out = join(dir, 'sticker.webm');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);

  const encode = (bitrate: string, crf: number) =>
    runFfmpeg([
      '-y',
      '-t',
      '3',
      '-i',
      inp,
      '-an',
      '-vf',
      'scale=512:512:force_original_aspect_ratio=decrease,fps=30',
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      bitrate,
      '-crf',
      String(crf),
      '-deadline',
      'good',
      '-cpu-used',
      '5',
      '-pix_fmt',
      'yuv420p',
      out,
    ]);

  try {
    await writeFile(inp, input);
    for (const [br, crf] of [
      ['350k', 40],
      ['180k', 48],
    ] as const) {
      if (!(await encode(br, crf))) continue;
      const s = await stat(out).catch(() => null);
      if (s && s.size > 0 && s.size <= MAX_BYTES) {
        const buf = await readFile(out);
        await cleanup();
        return buf;
      }
    }
  } catch (err) {
    log.warn({ err }, 'video sticker conversion failed');
  }
  await cleanup();
  return null;
}
