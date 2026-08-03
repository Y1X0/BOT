import sharp from 'sharp';
import { createLogger } from '../core/logger';

const log = createLogger('sticker');
const SIZE = 512;

export type StickerEffect = 'border' | 'circle';

async function safe(fn: () => Promise<Buffer>): Promise<Buffer | null> {
  try {
    return await fn();
  } catch (err) {
    log.warn({ err }, 'sharp sticker op failed');
    return null;
  }
}

/** Plain photo → 512-fit WEBP sticker. */
export function photoToSticker(image: Buffer): Promise<Buffer | null> {
  return safe(() => sharp(image).resize(SIZE, SIZE, { fit: 'inside' }).webp({ quality: 90 }).toBuffer());
}

/** Photo → 100×100 WEBP for a custom-emoji set (transparent padding). */
export function photoToEmoji(image: Buffer): Promise<Buffer | null> {
  return safe(() =>
    sharp(image)
      .resize(100, 100, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90 })
      .toBuffer(),
  );
}

/** White border frame, or circular crop with transparency. */
export function applyEffect(image: Buffer, effect: StickerEffect): Promise<Buffer | null> {
  if (effect === 'border') {
    const b = 20;
    return safe(() =>
      sharp(image)
        .resize(SIZE - 2 * b, SIZE - 2 * b, { fit: 'inside' })
        .extend({ top: b, bottom: b, left: b, right: b, background: '#ffffff' })
        .webp({ quality: 90 })
        .toBuffer(),
    );
  }
  const mask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}" fill="#fff"/></svg>`,
  );
  return safe(() =>
    sharp(image)
      .resize(SIZE, SIZE, { fit: 'cover' })
      .ensureAlpha()
      .composite([{ input: mask, blend: 'dest-in' }])
      .webp({ quality: 90 })
      .toBuffer(),
  );
}

/** Draw a caption at the bottom (meme style). Arabic + English via Pango. */
export function addText(image: Buffer, text: string): Promise<Buffer | null> {
  return safe(async () => {
    const base = await sharp(image).resize(SIZE, SIZE, { fit: 'inside' }).png().toBuffer();
    const meta = await sharp(base).metadata();
    const w = meta.width ?? SIZE;
    const h = meta.height ?? SIZE;
    const fontSize = Math.round(w / 11) + 8;
    const stroke = Math.max(3, Math.round(fontSize / 12));
    const svg =
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="50%" y="${h - 18}" text-anchor="middle" ` +
      `font-family="Noto Naskh Arabic, DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="bold" ` +
      `fill="white" stroke="black" stroke-width="${stroke}" paint-order="stroke">${escapeXml(text)}</text></svg>`;
    return sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).webp({ quality: 90 }).toBuffer();
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
