import { existsSync } from 'node:fs';
import { GlobalFonts, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import { createLogger } from '../../core/logger';

const log = createLogger('card:lux');

/**
 * Shared "luxury card" primitives — the same premium look as the ID card (gold
 * double frame, corner flourishes, Cinzel Roman-cap English, ornamental
 * dividers), factored out so every card the bot renders (song, welcome, rank…)
 * shares one visual language. Kept separate from the id-card module so changing
 * one never risks the other; font registration is process-global and idempotent.
 */
let fontsReady = false;
export function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  const reg: [string, string][] = [
    ['@fontsource/cairo/files/cairo-arabic-400-normal.woff2', 'CairoAr'],
    ['@fontsource/cairo/files/cairo-arabic-700-normal.woff2', 'CairoAr'],
    ['@fontsource/cairo/files/cairo-latin-400-normal.woff2', 'CairoLat'],
    ['@fontsource/cairo/files/cairo-latin-700-normal.woff2', 'CairoLat'],
    ['@fontsource/noto-sans-math/files/noto-sans-math-latin-400-normal.woff2', 'MathDec'],
    ['@fontsource/amiri/files/amiri-arabic-400-normal.woff2', 'AmiriAr'],
    ['@fontsource/cinzel/files/cinzel-latin-600-normal.woff2', 'Cinzel'],
    ['@fontsource/cinzel/files/cinzel-latin-700-normal.woff2', 'Cinzel'],
    ['@fontsource/cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2', 'Cormorant'],
    ['@fontsource/noto-sans-symbols/files/noto-sans-symbols-symbols-400-normal.woff2', 'SymA'],
    ['@fontsource/noto-sans-symbols-2/files/noto-sans-symbols-2-symbols-400-normal.woff2', 'SymB'],
  ];
  for (const [f, fam] of reg) {
    try {
      GlobalFonts.registerFromPath(`node_modules/${f}`, fam);
    } catch (err) {
      log.warn({ err, f }, 'font register failed');
    }
  }
  const emojiPaths = [
    'assets/fonts/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf',
    '/usr/share/fonts/noto/NotoColorEmoji.ttf',
  ];
  for (const p of emojiPaths) {
    if (!existsSync(p)) continue;
    try {
      GlobalFonts.registerFromPath(p, 'NotoEmoji');
      break;
    } catch (err) {
      log.warn({ err, p }, 'emoji font register failed');
    }
  }
}

export const FONT = (weight: number, size: number): string =>
  `${weight} ${size}px CairoAr, AmiriAr, CairoLat, MathDec, SymA, SymB, NotoEmoji`;
export const LUX = (weight: number, size: number): string => `${weight} ${size}px Cinzel, Cormorant, CairoLat, serif`;
export const EMOJI = (size: number): string => `${size}px NotoEmoji, CairoAr, CairoLat`;

export interface LuxTheme {
  a: string; // accent (gold/cyan/…)
  a2: string; // lighter accent
  bg1: string; // gradient top
  bg2: string; // gradient bottom
}

export const GOLD: LuxTheme = { a: '#e8c86a', a2: '#f6e3a6', bg1: '#191131', bg2: '#0a0a14' };

export function hexRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Centered LTR text with manual letter-spacing (elegant tracked caps). */
export function drawTracked(ctx: SKRSContext2D, text: string, cx: number, y: number, spacing: number): void {
  ctx.textAlign = 'left';
  ctx.direction = 'ltr';
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  let x = cx - total / 2;
  chars.forEach((ch, i) => {
    ctx.fillText(ch, x, y);
    x += widths[i] + spacing;
  });
}

function cornerOrnament(ctx: SKRSContext2D, x: number, y: number, dx: number, dy: number, color: string): void {
  const len = 30;
  const len2 = 14;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + dx * len, y);
  ctx.lineTo(x, y);
  ctx.lineTo(x, y + dy * len);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + dx * len2, y + dy * 6);
  ctx.lineTo(x + dx * 6, y + dy * 6);
  ctx.lineTo(x + dx * 6, y + dy * len2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x + dx * 6, y + dy * 6);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();
}

/** A center diamond flanked by tapering gold lines — a decorative section rule. */
export function ornamentalDivider(ctx: SKRSContext2D, cx: number, y: number, half: number, color: string): void {
  const g = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.strokeStyle = g;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(cx - half, y);
  ctx.lineTo(cx - 12, y);
  ctx.moveTo(cx + 12, y);
  ctx.lineTo(cx + half, y);
  ctx.stroke();
  ctx.fillStyle = color;
  for (const [ox, s] of [[0, 4.5], [-8, 2.2], [8, 2.2]] as [number, number][]) {
    ctx.save();
    ctx.translate(cx + ox, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-s, -s, s * 2, s * 2);
    ctx.restore();
  }
}

/** The full premium frame: double gold border + four corner flourishes. */
export function drawLuxuryFrame(ctx: SKRSContext2D, W: number, H: number, t: LuxTheme): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexRgba(t.a, 0.6);
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 28);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(t.a, 0.28);
  roundRect(ctx, 11, 11, W - 22, H - 22, 22);
  ctx.stroke();
  const g = hexRgba(t.a, 0.75);
  cornerOrnament(ctx, 24, 24, 1, 1, g);
  cornerOrnament(ctx, W - 24, 24, -1, 1, g);
  cornerOrnament(ctx, 24, H - 24, 1, -1, g);
  cornerOrnament(ctx, W - 24, H - 24, -1, -1, g);
}

/** Fill the card background: dark gradient, optional cover image as a darkened
 *  full-bleed backdrop, then a soft accent halo up top. */
export function drawLuxuryBackground(
  ctx: SKRSContext2D,
  W: number,
  H: number,
  t: LuxTheme,
  cover?: Image | null,
): void {
  ctx.fillStyle = t.bg2;
  ctx.fillRect(0, 0, W, H);
  if (cover) {
    const scale = Math.max(W / cover.width, H / cover.height) * 1.1;
    const dw = cover.width * scale;
    const dh = cover.height * scale;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(cover, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.globalAlpha = 1;
  }
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, hexRgba(t.bg1, cover ? 0.72 : 0.98));
  bg.addColorStop(1, hexRgba(t.bg2, cover ? 0.92 : 0.99));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
}
