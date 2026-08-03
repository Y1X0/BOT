import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../core/logger';

const log = createLogger('sticker');

export interface StickerResult {
  filePath: string;
  cleanup: () => Promise<void>;
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
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
 * Convert an image buffer into a Telegram-ready static sticker: a WEBP scaled to
 * fit within 512×512 (longest side = 512), preserving aspect ratio.
 */
export async function photoToSticker(image: Buffer): Promise<StickerResult | null> {
  const dir = await mkdtemp(join(tmpdir(), 'stk-'));
  const input = join(dir, 'in');
  const output = join(dir, 'sticker.webp');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);

  try {
    await writeFile(input, image);
    const ok = await runFfmpeg([
      '-y',
      '-i',
      input,
      '-vf',
      "scale=512:512:force_original_aspect_ratio=decrease",
      '-c:v',
      'libwebp',
      '-q:v',
      '80',
      '-frames:v',
      '1',
      '-an',
      output,
    ]);
    if (ok) {
      const s = await stat(output).catch(() => null);
      if (s && s.size > 0) return { filePath: output, cleanup };
    }
  } catch (err) {
    log.warn({ err }, 'sticker conversion failed');
  }
  await cleanup();
  return null;
}
