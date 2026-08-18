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
