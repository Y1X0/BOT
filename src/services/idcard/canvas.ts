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
// Emoji-first font for drawing icons/emoji, so the color-emoji face is chosen
// directly instead of relying on per-glyph fallback landing on it.
const EMOJI = (size: number) => `${size}px NotoEmoji, CairoAr, CairoLat`;

/** Runtime font diagnostics (used by the /idfonts admin command). */
export function fontDiagnostics(): { emojiPath: string; hasNotoEmoji: boolean; families: string[]; coloredPixels: number } {
  ensureFonts();
  const paths = ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', '/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf'];
  const emojiPath = paths.find((p) => existsSync(p)) ?? 'NOT FOUND';
  const canvas = createCanvas(120, 120);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, 120, 120);
  ctx.fillStyle = '#fff';
  ctx.font = EMOJI(64);
  ctx.fillText('🛡', 20, 90);
  const data = ctx.getImageData(0, 0, 120, 120).data;
  let colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.abs(r - g) > 25 || Math.abs(g - b) > 25 || Math.abs(r - b) > 25) colored++;
  }
  let hasNotoEmoji = false;
  try {
    hasNotoEmoji = GlobalFonts.has('NotoEmoji');
  } catch {
    /* older API */
  }
  let families: string[] = [];
  try {
    families = (GlobalFonts.families as unknown as { family: string }[]).map((f) => f.family);
  } catch {
    /* ignore */
  }
  return { emojiPath, hasNotoEmoji, families, coloredPixels: colored };
}

function hexRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Fit a name into the card: one line at the largest size that fits, else wrap
 * to two balanced lines at a smaller size, truncating only as a last resort.
 */
function fitName(ctx: SKRSContext2D, raw: string, maxW: number): { lines: string[]; size: number } {
  const name = (raw || '—').trim();
  ctx.direction = 'rtl';
  // 1) single line, largest size 34→24 that fits.
  for (let s = 34; s >= 24; s--) {
    ctx.font = FONT(700, s);
    if (ctx.measureText(name).width <= maxW) return { lines: [name], size: s };
  }
  // 2) split into two lines near the middle, preferring a space break.
  const mid = Math.floor(name.length / 2);
  let sp = -1;
  for (let off = 0; off <= mid; off++) {
    if (name[mid - off] === ' ') { sp = mid - off; break; }
    if (name[mid + off] === ' ') { sp = mid + off; break; }
  }
  if (sp === -1) sp = mid;
  let l1 = name.slice(0, sp).trim();
  let l2 = name.slice(sp).trim();
  for (let s = 27; s >= 18; s--) {
    ctx.font = FONT(700, s);
    if (ctx.measureText(l1).width <= maxW && ctx.measureText(l2).width <= maxW) return { lines: [l1, l2], size: s };
  }
  // 3) still too long at the minimum size → truncate each line to fit.
  ctx.font = FONT(700, 18);
  while (l1.length > 1 && ctx.measureText(l1).width > maxW) l1 = l1.slice(0, -1);
  while (l2.length > 1 && ctx.measureText(l2 + '…').width > maxW) l2 = l2.slice(0, -1);
  return { lines: [l1, l2 + '…'], size: 18 };
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
  ctx.font = EMOJI(30);
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

  // Name — fit on one line if it can at a readable size, else wrap to two
  // lines (like the old card did), so the full name always shows.
  const maxNameW = W - 46;
  const fit = fitName(ctx, d.name, maxNameW);
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.font = FONT(700, fit.size);
  const lineGap = fit.size + 6;
  let ny = fit.lines.length === 2 ? 280 : 292;
  for (const line of fit.lines) {
    const w = Math.min(ctx.measureText(line).width, maxNameW);
    const ng = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    ng.addColorStop(0, '#ffffff');
    ng.addColorStop(0.5, t.a);
    ng.addColorStop(1, '#ffffff');
    ctx.fillStyle = ng;
    ctx.fillText(line, cx, ny);
    ny += lineGap;
  }

  // Username, positioned under the (1- or 2-line) name.
  const userY = fit.lines.length === 2 ? ny + 2 : 320;
  ctx.direction = 'ltr';
  ctx.fillStyle = '#b9c0d4';
  ctx.font = FONT(400, 17);
  ctx.fillText(d.username, cx, userY);

  // Rank pill, under the username.
  const pillY = userY + 16;
  ctx.font = FONT(700, 18);
  ctx.direction = 'rtl';
  const rankW = ctx.measureText(d.rank).width + 40;
  const pillX = cx - rankW / 2;
  const rg = ctx.createLinearGradient(pillX, 0, pillX + rankW, 0);
  rg.addColorStop(0, t.a);
  rg.addColorStop(1, t.a2);
  ctx.fillStyle = rg;
  roundRect(ctx, pillX, pillY, rankW, 34, 17);
  ctx.fill();
  ctx.fillStyle = '#141018';
  ctx.textAlign = 'center';
  ctx.fillText(d.rank, cx, pillY + 23);

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
    // icon on the right (emoji-first font so the color glyph is used).
    ctx.font = EMOJI(23);
    ctx.textAlign = 'center';
    ctx.direction = 'ltr';
    ctx.fillText(icon, x + w - 24, y + h / 2 + 8);
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
  ctx.font = EMOJI(15);
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
