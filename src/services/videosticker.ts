import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../core/logger';

const log = createLogger('videosticker');

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

/** Video sticker: WEBM/VP9, ≤512px, ≤3s, no audio, ≤256KB. */
export function videoToSticker(input: Buffer): Promise<Buffer | null> {
  return encodeVideo(input, 512, 256 * 1024, [
    ['350k', 40],
    ['180k', 48],
  ]);
}

/** Video custom-emoji: WEBM/VP9, 100×100, ≤3s, no audio, ≤64KB. */
export function videoToEmoji(input: Buffer): Promise<Buffer | null> {
  return encodeVideo(input, 100, 64 * 1024, [
    ['150k', 45],
    ['80k', 52],
  ]);
}

async function encodeVideo(
  input: Buffer,
  size: number,
  maxBytes: number,
  tiers: ReadonlyArray<readonly [string, number]>,
): Promise<Buffer | null> {
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
      `scale=${size}:${size}:force_original_aspect_ratio=decrease,fps=30`,
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
    for (const [br, crf] of tiers) {
      if (!(await encode(br, crf))) continue;
      const s = await stat(out).catch(() => null);
      if (s && s.size > 0 && s.size <= maxBytes) {
        const buf = await readFile(out);
        await cleanup();
        return buf;
      }
    }
  } catch (err) {
    log.warn({ err }, 'video encode failed');
  }
  await cleanup();
  return null;
}
