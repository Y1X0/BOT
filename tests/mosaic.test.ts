import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { sliceToEmojiTiles, MAX_TILES, MAX_COLS } from '../src/services/mosaic';

/** A solid-color test image of the given size. */
function img(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

describe('sliceToEmojiTiles', () => {
  it('slices into cols×rows tiles, each exactly 100×100 webp', async () => {
    const res = await sliceToEmojiTiles(await img(600, 600), 6);
    expect(res).not.toBeNull();
    expect(res!.cols).toBe(6);
    expect(res!.rows).toBe(6); // square image → rows == cols
    expect(res!.tiles).toHaveLength(36);
    const meta = await sharp(res!.tiles[0]).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });

  it('derives rows from aspect ratio (taller image → more rows)', async () => {
    const res = await sliceToEmojiTiles(await img(400, 800), 4);
    expect(res!.cols).toBe(4);
    expect(res!.rows).toBe(8); // 2× tall
    expect(res!.tiles).toHaveLength(32);
  });

  it('clamps columns and keeps the total within budget', async () => {
    const res = await sliceToEmojiTiles(await img(500, 5000), 20); // absurd request
    expect(res!.cols).toBeLessThanOrEqual(MAX_COLS);
    expect(res!.tiles.length).toBeLessThanOrEqual(MAX_TILES);
  });
});
