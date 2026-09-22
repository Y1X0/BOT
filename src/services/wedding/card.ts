/**
 * Wedding invitation card — a romantic sibling of the id/owner cards. Two people
 * (names + avatars) on one ornate gold-on-wine card with a beating heart, and an
 * ANIMATED MP4 variant (floating hearts + heart pulse + gold shine sweep) for a
 * proper "كرت عرس". CPU-only via @napi-rs/canvas → ffmpeg (raw RGBA frames), the
 * exact pipeline the other cards use — no browser.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import {
  ensureFonts,
  FONT,
  LUX,
  EMOJI,
  hexRgba,
  drawTracked,
  ornamentalDivider,
  drawLuxuryFrame,
  drawLuxuryBackground,
  type LuxTheme,
} from '../card/lux';

let lastMp4Error = '';
export function getLastWeddingVideoError(): string {
  return lastMp4Error;
}

export interface WeddingCardData {
  aName: string;
  bName: string;
  aAvatarDataUri?: string;
  bAvatarDataUri?: string;
  aInitial: string;
  bInitial: string;
  note?: string; // optional line under the names (a date, a blessing…)
}

const W = 640;
const H = 700;

// A warm wine-and-gold palette — romantic, distinct from the id card's indigo.
const ROSE: LuxTheme = { a: '#e8c86a', a2: '#f7dde6', bg1: '#3a0f1e', bg2: '#140309' };
const HEART = '#ff5d7a';
const HEART_HI = '#ff9fb2';

async function loadImg(uri?: string): Promise<Image | null> {
  if (!uri) return null;
  return loadImage(uri).catch(() => null);
}

/** Shrink the current font until `text` fits `maxWidth` (returns the size used). */
function fitFont(ctx: SKRSContext2D, text: string, maxWidth: number, start: number, min: number): number {
  let size = start;
  for (;;) {
    ctx.font = FONT(700, size);
    if (ctx.measureText(text).width <= maxWidth || size <= min) return size;
    size -= 2;
  }
}

function heartPath(ctx: SKRSContext2D, cx: number, cy: number, s: number): void {
  // s = half-width; a smooth cardioid-ish heart.
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.9);
  ctx.bezierCurveTo(cx + s * 1.3, cy - s * 0.2, cx + s * 0.55, cy - s * 1.1, cx, cy - s * 0.35);
  ctx.bezierCurveTo(cx - s * 0.55, cy - s * 1.1, cx - s * 1.3, cy - s * 0.2, cx, cy + s * 0.9);
  ctx.closePath();
}

function drawHeart(ctx: SKRSContext2D, cx: number, cy: number, s: number, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(cx - s * 0.3, cy - s * 0.4, s * 0.1, cx, cy, s * 1.4);
  g.addColorStop(0, HEART_HI);
  g.addColorStop(1, HEART);
  heartPath(ctx, cx, cy, s);
  ctx.fillStyle = g;
  ctx.shadowColor = hexRgba(HEART, 0.6);
  ctx.shadowBlur = s * 0.8;
  ctx.fill();
  ctx.restore();
}

/** Circular avatar with a double gold ring; falls back to an initial on a gradient. */
function drawMedallion(
  ctx: SKRSContext2D,
  img: Image | null,
  cx: number,
  cy: number,
  r: number,
  initial: string,
  t: LuxTheme,
): void {
  ctx.save();
  // Outer glow ring.
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.strokeStyle = hexRgba(t.a, 0.5);
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, hexRgba(t.a, 0.35));
    g.addColorStop(1, hexRgba(t.bg1, 0.9));
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = t.a2;
    ctx.font = FONT(700, r * 1.05); // Arabic-capable so an Arabic initial isn't tofu
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, cx, cy + 2);
  }
  ctx.restore();

  // Inner gold ring.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = t.a;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

// Fixed pseudo-random floating hearts (deterministic so frames are stable).
const FLOATERS = Array.from({ length: 10 }, (_, i) => ({
  x: 40 + ((i * 61) % (W - 80)),
  size: 6 + (i % 4) * 3,
  speed: 0.6 + (i % 5) * 0.12,
  phase0: (i * 0.137) % 1,
}));

/**
 * Draw the whole card. `phase` in [0,1) animates; a negative value renders the
 * static still (no floaters, mid-pulse heart, fixed shine).
 */
function drawWedding(
  ctx: SKRSContext2D,
  d: WeddingCardData,
  aImg: Image | null,
  bImg: Image | null,
  phase: number,
): void {
  const animated = phase >= 0;
  const ph = animated ? phase : 0;

  drawLuxuryBackground(ctx, W, H, ROSE);

  // Floating hearts rising (video only), behind the content.
  if (animated) {
    for (const f of FLOATERS) {
      const p = (f.phase0 + ph * f.speed) % 1;
      const y = H - 40 - p * (H - 120);
      const a = Math.sin(p * Math.PI) * 0.5; // fade in/out over the trip
      if (a > 0.02) drawHeart(ctx, f.x, y, f.size, a);
    }
  }

  drawLuxuryFrame(ctx, W, H, ROSE);

  // Header.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ROSE.a2;
  ctx.font = FONT(700, 40);
  ctx.fillText('دعوة زفاف', W / 2, 88);
  ctx.fillStyle = hexRgba(ROSE.a, 0.85);
  ctx.font = LUX(600, 20);
  drawTracked(ctx, 'WEDDING INVITATION', W / 2, 118, 4);
  ornamentalDivider(ctx, W / 2, 140, 150, ROSE.a);

  // Two medallions.
  const r = 92;
  const cy = 300;
  const axC = 176;
  const bxC = W - 176;
  drawMedallion(ctx, aImg, axC, cy, r, d.aInitial, ROSE);
  drawMedallion(ctx, bImg, bxC, cy, r, d.bInitial, ROSE);

  // Names under each medallion (fit to width).
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  const nameMax = 220;
  const aSize = fitFont(ctx, d.aName, nameMax, 34, 18);
  ctx.font = FONT(700, aSize);
  ctx.fillText(d.aName, axC, cy + r + 46);
  const bSize = fitFont(ctx, d.bName, nameMax, 34, 18);
  ctx.font = FONT(700, bSize);
  ctx.fillText(d.bName, bxC, cy + r + 46);

  // Beating heart in the middle.
  const pulse = 1 + (animated ? 0.1 * Math.sin(ph * Math.PI * 2) : 0.04);
  drawHeart(ctx, W / 2, cy - 6, 34 * pulse);
  // The classic "&" between the couple, tucked under the heart.
  ctx.fillStyle = ROSE.a2;
  ctx.font = LUX(700, 30);
  ctx.fillText('&', W / 2, cy + 58);

  // Blessing line + optional note.
  ornamentalDivider(ctx, W / 2, cy + r + 96, 170, ROSE.a);
  ctx.fillStyle = ROSE.a2;
  ctx.font = FONT(700, 26);
  ctx.fillText('مبارك لكما الزواج 💍', W / 2, cy + r + 138);
  if (d.note) {
    ctx.fillStyle = hexRgba('#ffffff', 0.85);
    const nSize = fitFont(ctx, d.note, W - 120, 24, 14);
    ctx.font = FONT(400, nSize);
    ctx.fillText(d.note, W / 2, cy + r + 176);
  }

  // Small emoji flourish at the very bottom.
  ctx.font = EMOJI(26);
  ctx.fillText('💐  💞  💐', W / 2, H - 42);

  // Diagonal gold shine sweep (subtle; animated in video).
  const sweep = animated ? ph : 0.5;
  const sx = -W + sweep * (W * 2);
  const grad = ctx.createLinearGradient(sx, 0, sx + 180, H);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, hexRgba(ROSE.a2, 0.10));
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

export async function renderWeddingCardImage(d: WeddingCardData): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const [aImg, bImg] = await Promise.all([loadImg(d.aAvatarDataUri), loadImg(d.bAvatarDataUri)]);
  drawWedding(ctx, d, aImg, bImg, -1);
  return canvas.encode('jpeg', 86);
}

const MP4_FPS = 24;
const MP4_FRAMES = 36; // ~1.5s loop

export async function renderWeddingCardVideo(d: WeddingCardData): Promise<{ buffer: Buffer; ext: string } | null> {
  ensureFonts();
  lastMp4Error = '';
  const dir = await mkdtemp(join(tmpdir(), 'wedding-')).catch(() => null);
  if (!dir) {
    lastMp4Error = 'tmpdir failed';
    return null;
  }
  const out = join(dir, 'wedding.mp4');
  const [aImg, bImg] = await Promise.all([loadImg(d.aAvatarDataUri), loadImg(d.bAvatarDataUri)]);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  return new Promise((resolve) => {
    const args = [
      '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${W}x${H}`,
      '-framerate', String(MP4_FPS), '-i', '-',
      '-an', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', out,
    ];
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stdin = p.stdin;
    if (!stdin) {
      lastMp4Error = 'no ffmpeg stdin';
      void rm(dir, { recursive: true, force: true });
      return resolve(null);
    }
    let stderr = '';
    p.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-400);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 45_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      lastMp4Error = (e as { code?: string }).code === 'ENOENT' ? 'ffmpeg not installed' : e.message;
      void rm(dir, { recursive: true, force: true });
      resolve(null);
    });
    p.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        lastMp4Error = stderr.split('\n').filter(Boolean).pop()?.slice(0, 160) || `ffmpeg exit ${code}`;
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        return resolve(null);
      }
      const buffer = await readFile(out).catch(() => null);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      resolve(buffer ? { buffer, ext: 'mp4' } : null);
    });

    let i = 0;
    const pump = (): void => {
      while (i < MP4_FRAMES) {
        drawWedding(ctx, d, aImg, bImg, i / MP4_FRAMES);
        i++;
        const img = ctx.getImageData(0, 0, W, H);
        const frame = Buffer.from(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength);
        if (!stdin.write(frame)) {
          stdin.once('drain', pump);
          return;
        }
      }
      stdin.end();
    };
    stdin.on('error', () => undefined);
    pump();
  });
}
