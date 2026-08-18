import sharp from 'sharp';
import { createLogger } from '../../core/logger';

const log = createLogger('image:postprocess');

/**
 * Quick, cheap polish for the free models' output: auto-levels (normalise),
 * a gentle saturation lift, and light sharpening. This makes flat/soft results
 * read as noticeably crisper and more vivid without any paid upscaler. Returns
 * the original buffer unchanged if processing fails.
 */
export async function enhanceImage(buf: Buffer): Promise<Buffer> {
  try {
    return await sharp(buf)
      .normalise() // stretch contrast to full range
      .modulate({ saturation: 1.12, brightness: 1.02 })
      .sharpen({ sigma: 1.0 })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (err) {
    log.warn({ err }, 'post-process failed, sending original');
    return buf;
  }
}

/**
 * Cheap "detail" score for an image: the mean per-channel standard deviation.
 * Flat/washed/mushy free-model outputs score low; crisp, contrasty ones score
 * high. Used to pick the better of several candidates (best-of-N).
 */
async function detailScore(buf: Buffer): Promise<number> {
  try {
    const { channels } = await sharp(buf).stats();
    if (!channels.length) return 0;
    return channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length;
  } catch {
    return 0;
  }
}

/** From several candidate images, return the one with the most detail/contrast. */
export async function pickBestImage(buffers: Buffer[]): Promise<Buffer> {
  const valid = buffers.filter((b) => b && b.length > 0);
  if (valid.length <= 1) return valid[0] ?? buffers[0];
  const scored = await Promise.all(valid.map(async (b) => ({ b, score: await detailScore(b) })));
  scored.sort((x, y) => y.score - x.score);
  return scored[0].b;
}
