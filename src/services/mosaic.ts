import sharp from 'sharp';
import { createLogger } from '../core/logger';

const log = createLogger('mosaic');

// Telegram custom emoji are exactly 100×100. Tiles must match so they line up
// seamlessly when the set is sent back as a grid to reconstruct the picture.
const TILE = 100;
export const MIN_COLS = 3;
export const MAX_COLS = 9;
// Upload time + set limits budget: each tile is one uploadStickerFile call.
export const MAX_TILES = 90;

export interface MosaicResult {
  tiles: Buffer[]; // row-major (left→right, top→bottom)
  cols: number;
  rows: number;
}

/**
 * Slice ONE image into `cols`×`rows` 100×100 WEBP tiles that, sent together as
 * custom emoji (row by row), reassemble into the original picture. Rows are
 * derived from the image's aspect ratio so tiles stay square; the total is
 * capped so creation stays quick. Returns null on failure.
 */
export async function sliceToEmojiTiles(image: Buffer, colsWanted: number): Promise<MosaicResult | null> {
  try {
    const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.round(colsWanted) || 6));
    const meta = await sharp(image).metadata();
    const aspect = (meta.height ?? 1) / (meta.width ?? 1);
    let rows = Math.max(2, Math.round(cols * aspect));
    // Trim rows (not cols) to respect the tile budget — keeps the width intact.
    while (cols * rows > MAX_TILES && rows > 2) rows--;

    const W = cols * TILE;
    const H = rows * TILE;
    // Fill to the exact grid, then lift contrast/saturation a touch so the
    // picture "pops" as a mosaic instead of looking like a flat, chopped photo.
    const flat = await sharp(image)
      .resize(W, H, { fit: 'fill' })
      .modulate({ saturation: 1.14, brightness: 1.02 })
      .linear(1.08, -8)
      .toBuffer();

    // A small transparent frame inside each tile leaves a clean gap between
    // neighbours when they're placed together — the "designed panel" grid look.
    const GAP = 5;
    const inner = TILE - 2 * GAP;

    const tiles: Buffer[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const content = await sharp(flat)
          .extract({ left: c * TILE, top: r * TILE, width: TILE, height: TILE })
          .resize(inner, inner, { fit: 'fill' })
          .toBuffer();
        const tile = await sharp({
          create: { width: TILE, height: TILE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
          .composite([{ input: content, left: GAP, top: GAP }])
          .webp({ quality: 92 })
          .toBuffer();
        tiles.push(tile);
      }
    }
    return { tiles, cols, rows };
  } catch (err) {
    log.warn({ err }, 'mosaic slice failed');
    return null;
  }
}
