import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { createLogger } from '../../core/logger';
import type { IdCardImageData, CardTheme } from './image';

const log = createLogger('idcard:canvas');

// Last MP4-render failure reason, surfaced through image.ts' getLastVideoError.
let lastMp4Error = '';
export function getLastMp4Error(): string {
  return lastMp4Error;
}

type Avatar = Awaited<ReturnType<typeof loadImage>>;
async function loadAvatar(d: IdCardImageData): Promise<Avatar | null> {
  if (!d.avatarDataUri) return null;
  return loadImage(d.avatarDataUri).catch(() => null);
}

// Register fonts once: Cairo (Arabic + Latin, 400/700) for text, Noto Color
// Emoji for the icons. @napi-rs/canvas shapes Arabic correctly and renders
// color emoji, entirely on CPU — no browser.
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  // Register Arabic and Latin subsets under SEPARATE families — canvas has no
  // per-glyph fallback within one family, so a shared family would render Latin
  // digits (which the Arabic subset lacks) as tofu. A font list falls back
  // across families per glyph.
  const cairo = 'node_modules/@fontsource/cairo/files';
  const reg: [string, string][] = [
    ['cairo-arabic-400-normal.woff2', 'CairoAr'],
    ['cairo-arabic-700-normal.woff2', 'CairoAr'],
    ['cairo-latin-400-normal.woff2', 'CairoLat'],
    ['cairo-latin-700-normal.woff2', 'CairoLat'],
  ];
  for (const [f, fam] of reg) {
    try {
      GlobalFonts.registerFromPath(`${cairo}/${f}`, fam);
    } catch (err) {
      log.warn({ err, f }, 'cairo font register failed');
    }
  }
  for (const p of ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', '/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf']) {
    if (existsSync(p)) {
      try {
        GlobalFonts.registerFromPath(p, 'NotoEmoji');
      } catch {
        /* ignore */
      }
      break;
    }
  }
}

const FONT = (weight: number, size: number) => `${weight} ${size}px CairoAr, CairoLat, NotoEmoji`;

function hexRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const W = 640;
const H = 792;

/**
 * Draw the whole card onto `ctx`. `phase` (0..1) animates a diagonal gold shine
 * sweep for the video frames; pass a negative value for the static image (no
 * shine). Everything else is identical between the image and every video frame.
 */
function drawCard(ctx: SKRSContext2D, d: IdCardImageData, t: CardTheme, avatar: Avatar | null, phase: number): void {
  // Opaque backdrop so the whole frame is painted — lets us encode JPEG (a
  // fraction of the PNG size → far faster upload) instead of a transparent PNG.
  ctx.fillStyle = '#0e0b14';
  ctx.fillRect(0, 0, W, H);

  // Background: darkened avatar cover if present, else theme gradient.
  if (avatar) {
    const scale = Math.max(W / avatar.width, H / avatar.height) * 1.15;
    const dw = avatar.width * scale;
    const dh = avatar.height * scale;
    ctx.drawImage(avatar, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, avatar ? t.bg1 : t.bg1.replace(/[\d.]+\)$/, '0.97)'));
  bg.addColorStop(1, avatar ? t.bg2 : t.bg2.replace(/[\d.]+\)$/, '0.99)'));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Gold border.
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexRgba(t.a, 0.55);
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 33);
  ctx.stroke();

  const cx = W / 2;

  // Crown / header decoration.
  ctx.fillStyle = t.a;
  ctx.font = FONT(400, 30);
  ctx.textAlign = 'center';
  ctx.fillText(t.top, cx, 52);

  // Avatar circle.
  const ar = 74;
  const acy = 168;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, cx - ar, acy - ar, ar * 2, ar * 2);
  } else {
    const g = ctx.createLinearGradient(cx - ar, acy - ar, cx + ar, acy + ar);
    g.addColorStop(0, t.ph1);
    g.addColorStop(1, t.ph2);
    ctx.fillStyle = g;
    ctx.fillRect(cx - ar, acy - ar, ar * 2, ar * 2);
    ctx.fillStyle = t.a;
    ctx.font = FONT(700, 64);
    ctx.textAlign = 'center';
    ctx.fillText(d.initial || '?', cx, acy + 22);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = t.a;
  ctx.stroke();

  // Name (gold gradient) + username.
  ctx.font = FONT(700, 32);
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  const name = d.name.length > 30 ? d.name.slice(0, 29) + '…' : d.name;
  const nameW = Math.min(ctx.measureText(name).width, W - 60);
  const ng = ctx.createLinearGradient(cx - nameW / 2, 0, cx + nameW / 2, 0);
  ng.addColorStop(0, '#ffffff');
  ng.addColorStop(0.5, t.a);
  ng.addColorStop(1, '#ffffff');
  ctx.fillStyle = ng;
  ctx.fillText(name, cx, 292);
  ctx.direction = 'ltr';
  ctx.fillStyle = '#b9c0d4';
  ctx.font = FONT(400, 17);
  ctx.fillText(d.username, cx, 320);

  // Rank pill.
  ctx.font = FONT(700, 18);
  ctx.direction = 'rtl';
  const rankW = ctx.measureText(d.rank).width + 40;
  const pillX = cx - rankW / 2;
  const rg = ctx.createLinearGradient(pillX, 0, pillX + rankW, 0);
  rg.addColorStop(0, t.a);
  rg.addColorStop(1, t.a2);
  ctx.fillStyle = rg;
  roundRect(ctx, pillX, 336, rankW, 34, 17);
  ctx.fill();
  ctx.fillStyle = '#141018';
  ctx.textAlign = 'center';
  ctx.fillText(d.rank, cx, 359);

  // Divider.
  const dv = ctx.createLinearGradient(28, 0, W - 28, 0);
  dv.addColorStop(0, 'rgba(0,0,0,0)');
  dv.addColorStop(0.5, hexRgba(t.a, 0.55));
  dv.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = dv;
  ctx.fillRect(28, 392, W - 56, 1.5);

  // Stat tiles (2 columns, RTL: first item on the right).
  const tile = (x: number, y: number, w: number, h: number, icon: string, label: string, value: string) => {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    roundRect(ctx, x, y, w, h, 15);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexRgba(t.a, 0.16);
    roundRect(ctx, x, y, w, h, 15);
    ctx.stroke();
    // icon on the right.
    ctx.font = FONT(400, 24);
    ctx.textAlign = 'center';
    ctx.direction = 'ltr';
    ctx.fillText(icon, x + w - 24, y + h / 2 + 9);
    // label + value, right-aligned to the left of the icon.
    const tx = x + w - 48;
    ctx.textAlign = 'right';
    ctx.direction = 'rtl';
    ctx.fillStyle = '#aab0c6';
    ctx.font = FONT(400, 12.5);
    ctx.fillText(label, tx, y + 24);
    ctx.fillStyle = '#ffffff';
    ctx.font = FONT(700, 16.5);
    const val = value.length > 22 ? value.slice(0, 21) + '…' : value;
    ctx.fillText(val, tx, y + 46);
  };

  const pad = 28;
  const gap = 11;
  const tw = (W - pad * 2 - gap) / 2;
  const th = 60;
  const L = pad; // left tile x
  const R = pad + tw + gap; // right tile x
  let y = 410;
  tile(R, y, tw, th, '🛡', 'الحالة', d.stats);
  tile(L, y, tw, th, '🎖', 'اللقب', d.title);
  y += th + gap;
  tile(R, y, tw, th, '⭐', 'المستوى', d.level);
  tile(L, y, tw, th, '🔥', 'النقاط', d.xp);
  y += th + gap;
  tile(R, y, tw, th, '💬', 'الرسائل', d.messages);
  tile(L, y, tw, th, '⚡', 'التفاعل', d.interaction);
  y += th + gap;
  tile(L, y, W - pad * 2, th, '📅', 'تاريخ الانضمام', d.joined);
  y += th + gap;

  // ID bar.
  ctx.fillStyle = hexRgba(t.a, 0.1);
  roundRect(ctx, pad, y, W - pad * 2, 46, 14);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(t.a, 0.3);
  roundRect(ctx, pad, y, W - pad * 2, 46, 14);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.fillStyle = t.a;
  ctx.font = FONT(700, 15);
  const idLabel = '🆔 الآيدي';
  ctx.fillText(idLabel, cx + 70, y + 29);
  ctx.direction = 'ltr';
  ctx.fillStyle = '#ffffff';
  ctx.font = FONT(700, 18);
  ctx.fillText(d.id, cx - 40, y + 29);

  // Footer.
  ctx.textAlign = 'center';
  ctx.fillStyle = hexRgba(t.a, 0.85);
  ctx.font = FONT(400, 15);
  ctx.fillText(t.foot, cx, H - 24);

  // Animated diagonal gold shine sweep (video frames only).
  if (phase >= 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bandW = 190;
    const skew = 120;
    const x = -bandW - skew + phase * (W + bandW + skew * 2);
    const g = ctx.createLinearGradient(x, 0, x + bandW, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, hexRgba(t.a, 0.16));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + bandW, 0);
    ctx.lineTo(x + bandW - skew, H);
    ctx.lineTo(x - skew, H);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Render the static profile card to a JPEG with @napi-rs/canvas (fast, no browser). */
export async function renderCardPng(d: IdCardImageData, t: CardTheme): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const avatar = await loadAvatar(d);
  drawCard(ctx, d, t, avatar, -1);
  // JPEG at q82: a 640×792 card with an avatar cover is ~50–80KB vs ~500KB PNG,
  // so the Telegram upload drops from ~1s to a couple hundred ms.
  return canvas.encode('jpeg', 82);
}

/**
 * Render an ANIMATED profile card (gold shine sweep) as a short looping MP4 for
 * Telegram Premium members — WITHOUT a browser. Frames are drawn on CPU with
 * canvas and piped straight to ffmpeg as raw RGBA, which is far faster and
 * lighter than screen-recording a Chromium page. Returns null on any failure
 * (the caller then falls back to the static image card).
 */
const MP4_FPS = 24;
const MP4_FRAMES = 24; // ~1s loop

export async function renderCardMp4(d: IdCardImageData, t: CardTheme): Promise<{ buffer: Buffer; ext: string } | null> {
  ensureFonts();
  lastMp4Error = '';
  const dir = await mkdtemp(join(tmpdir(), 'idcard-')).catch(() => null);
  if (!dir) {
    lastMp4Error = 'tmpdir failed';
    return null;
  }
  const out = join(dir, 'card.mp4');
  const avatar = await loadAvatar(d);
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
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
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

    // Draw and stream each frame as raw RGBA, honoring backpressure.
    let i = 0;
    const pump = (): void => {
      while (i < MP4_FRAMES) {
        drawCard(ctx, d, t, avatar, i / MP4_FRAMES);
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
    stdin.on('error', () => undefined); // ignore EPIPE if ffmpeg died
    pump();
  });
}
