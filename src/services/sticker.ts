import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../core/logger';

const log = createLogger('sticker');

export interface StickerResult {
  filePath: string;
  cleanup: () => Promise<void>;
}
export type StickerEffect = 'border' | 'circle';

const FIT = 'scale=512:512:force_original_aspect_ratio=decrease';

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

/** Encode `image` to a 512-fit WEBP sticker using a caller-built filter. */
async function encodeWebp(
  image: Buffer,
  buildFilter: (dir: string) => Promise<string> | string,
): Promise<StickerResult | null> {
  const dir = await mkdtemp(join(tmpdir(), 'stk-'));
  const input = join(dir, 'in');
  const output = join(dir, 'sticker.webp');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  try {
    await writeFile(input, image);
    const filter = await buildFilter(dir);
    const ok = await runFfmpeg(['-y', '-i', input, '-vf', filter, '-c:v', 'libwebp', '-q:v', '80', '-frames:v', '1', '-an', output]);
    if (ok) {
      const s = await stat(output).catch(() => null);
      if (s && s.size > 0) return { filePath: output, cleanup };
    }
  } catch (err) {
    log.warn({ err }, 'webp encode failed');
  }
  await cleanup();
  return null;
}

/** Plain photo → sticker (fit within 512×512). */
export function photoToSticker(image: Buffer): Promise<StickerResult | null> {
  return encodeWebp(image, () => FIT);
}

/** Apply a visual effect: white border frame, or circular crop. */
export function applyEffect(image: Buffer, effect: StickerEffect): Promise<StickerResult | null> {
  const filter =
    effect === 'circle'
      ? "crop='min(iw,ih)':'min(iw,ih)',scale=512:512,format=rgba," +
        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-256)*(X-256)+(Y-256)*(Y-256),256*256),255,0)'"
      : `${FIT},drawbox=x=0:y=0:w=iw:h=ih:t=18:color=white`;
  return encodeWebp(image, () => filter);
}

const FONTS = [
  '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];
function pickFont(): string | null {
  return FONTS.find((f) => existsSync(f)) ?? null;
}

/** Draw a caption at the bottom of the sticker (meme style). */
export async function addText(image: Buffer, text: string): Promise<StickerResult | null> {
  const font = pickFont();
  if (!font) {
    log.warn('no font available for sticker text');
    return null;
  }
  const build = (shaping: boolean) => async (dir: string) => {
    const tf = join(dir, 'text.txt');
    await writeFile(tf, text);
    return (
      `${FIT},drawtext=fontfile=${font}:textfile=${tf}:reload=0:fontcolor=white:fontsize=46:` +
      `borderw=5:bordercolor=black:x=(w-text_w)/2:y=h-text_h-20${shaping ? ':text_shaping=1' : ''}`
    );
  };
  // Try with Arabic shaping first; fall back if this ffmpeg build lacks it.
  return (await encodeWebp(image, build(true))) ?? (await encodeWebp(image, build(false)));
}
