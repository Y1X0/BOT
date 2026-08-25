import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { createLogger } from '../../core/logger';
import type { IdCardImageData, CardTheme, OwnerCardData, DevCardData } from './image';

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
  const reg: [string, string][] = [
    ['@fontsource/cairo/files/cairo-arabic-400-normal.woff2', 'CairoAr'],
    ['@fontsource/cairo/files/cairo-arabic-700-normal.woff2', 'CairoAr'],
    ['@fontsource/cairo/files/cairo-latin-400-normal.woff2', 'CairoLat'],
    ['@fontsource/cairo/files/cairo-latin-700-normal.woff2', 'CairoLat'],
    // Noto Sans Math covers the "fancy"/decorated name letters people use
    // (Mathematical Alphanumeric Symbols: 𝐉𝐎𝐘 𝓙𝓸𝔂 𝕵𝖔𝖞 …). Without it those
    // render as tofu boxes. Cairo comes first, so normal text is unaffected.
    ['@fontsource/noto-sans-math/files/noto-sans-math-latin-400-normal.woff2', 'MathDec'],
    // Arabic Presentation Forms (ﺈ ﺳ ﮧ …) that Cairo lacks — Amiri covers them.
    ['@fontsource/amiri/files/amiri-arabic-400-normal.woff2', 'AmiriAr'],
    // Cinzel: elegant Roman capitals for the luxury English lines (eyebrow,
    // footer). Cormorant Garamond: a refined serif for smaller English accents.
    ['@fontsource/cinzel/files/cinzel-latin-600-normal.woff2', 'Cinzel'],
    ['@fontsource/cinzel/files/cinzel-latin-700-normal.woff2', 'Cinzel'],
    ['@fontsource/cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2', 'Cormorant'],
    // Decorated names also use arrows, geometric shapes, dingbats and enclosed
    // symbols (◤ ↖ ▧ ✦ ❂ …). Noto Sans Symbols (1+2) cover those ranges.
    ['@fontsource/noto-sans-symbols/files/noto-sans-symbols-symbols-400-normal.woff2', 'SymA'],
    ['@fontsource/noto-sans-symbols-2/files/noto-sans-symbols-2-symbols-400-normal.woff2', 'SymB'],
    // …and pull from many other scripts. Register each so skia can fall back
    // per glyph instead of drawing tofu boxes:
    ['@fontsource/noto-sans/files/noto-sans-cyrillic-400-normal.woff2', 'NCyr'],
    ['@fontsource/noto-sans/files/noto-sans-greek-400-normal.woff2', 'NGrk'],
    ['@fontsource/noto-sans/files/noto-sans-devanagari-400-normal.woff2', 'NDeva'],
    ['@fontsource/noto-sans-hebrew/files/noto-sans-hebrew-hebrew-400-normal.woff2', 'NHeb'],
    ['@fontsource/noto-sans-thai/files/noto-sans-thai-thai-400-normal.woff2', 'NThai'],
    ['@fontsource/noto-sans-thaana/files/noto-sans-thaana-thaana-400-normal.woff2', 'NThaana'],
    ['@fontsource/noto-sans-balinese/files/noto-sans-balinese-balinese-400-normal.woff2', 'NBali'],
    ['@fontsource/noto-sans-new-tai-lue/files/noto-sans-new-tai-lue-new-tai-lue-400-normal.woff2', 'NTaiLue'],
    ['@fontsource/noto-sans-egyptian-hieroglyphs/files/noto-sans-egyptian-hieroglyphs-egyptian-hieroglyphs-400-normal.woff2', 'NEgy'],
  ];
  for (const [f, fam] of reg) {
    try {
      GlobalFonts.registerFromPath(`node_modules/${f}`, fam);
    } catch (err) {
      log.warn({ err, f }, 'font register failed');
    }
  }
  // Color-emoji font. Prefer the copy BUNDLED in the repo (assets/fonts) so it's
  // present no matter how the host builds (Docker apt vs Nixpacks) — the system
  // package isn't guaranteed. Fall back to common system paths.
  const emojiPaths = [
    'assets/fonts/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf',
    '/usr/share/fonts/noto/NotoColorEmoji.ttf',
  ];
  let emojiOk = false;
  for (const p of emojiPaths) {
    if (!existsSync(p)) continue;
    try {
      GlobalFonts.registerFromPath(p, 'NotoEmoji');
      emojiOk = true;
      break;
    } catch (err) {
      log.warn({ err, p }, 'emoji font register failed');
    }
  }
  if (!emojiOk) log.warn('no color-emoji font registered — icons will be tofu');
}

const FONT = (weight: number, size: number) =>
  `${weight} ${size}px CairoAr, AmiriAr, CairoLat, MathDec, NCyr, NGrk, NDeva, NHeb, NThai, NThaana, NBali, NTaiLue, NEgy, SymA, SymB, NotoEmoji`;
// Emoji-first font for drawing icons/emoji, so the color-emoji face is chosen
// directly instead of relying on per-glyph fallback landing on it.
const EMOJI = (size: number) => `${size}px NotoEmoji, CairoAr, CairoLat`;
// Luxury serif for the English lines (Roman caps).
const LUX = (weight: number, size: number) => `${weight} ${size}px Cinzel, Cormorant, CairoLat, serif`;

/** Draw centered LTR text with manual letter-spacing (tracking) — gives the
 *  English caps that elegant, airy luxury look canvas fonts can't set alone. */
function drawTracked(ctx: SKRSContext2D, text: string, cx: number, y: number, spacing: number): void {
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

/** An L-shaped gold flourish at a card corner. dx/dy point inward (±1). */
function cornerOrnament(ctx: SKRSContext2D, x: number, y: number, dx: number, dy: number, color: string): void {
  const len = 34;
  const len2 = 16;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + dx * len, y);
  ctx.lineTo(x, y);
  ctx.lineTo(x, y + dy * len);
  ctx.stroke();
  // inner short accent, offset diagonally
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + dx * len2, y + dy * 7);
  ctx.lineTo(x + dx * 7, y + dy * 7);
  ctx.lineTo(x + dx * 7, y + dy * len2);
  ctx.stroke();
  // corner diamond
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x + dx * 7, y + dy * 7);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
  ctx.restore();
}

/** A center diamond flanked by tapering gold lines — a decorative section rule. */
function ornamentalDivider(ctx: SKRSContext2D, cx: number, y: number, half: number, color: string): void {
  const g = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.strokeStyle = g;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(cx - half, y);
  ctx.lineTo(cx - 14, y);
  ctx.moveTo(cx + 14, y);
  ctx.lineTo(cx + half, y);
  ctx.stroke();
  // center diamonds
  ctx.fillStyle = color;
  for (const [ox, s] of [[0, 5], [-9, 2.4], [9, 2.4]] as [number, number][]) {
    ctx.save();
    ctx.translate(cx + ox, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-s, -s, s * 2, s * 2);
    ctx.restore();
  }
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

  const cx = W / 2;

  // Soft gold halo behind the header/avatar for depth.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(cx, 150, 20, cx, 150, 300);
  halo.addColorStop(0, hexRgba(t.a, 0.14));
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, 380);
  ctx.restore();

  // Double gold frame: a bold outer border + a fine inner line.
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexRgba(t.a, 0.6);
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, 33);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(t.a, 0.28);
  roundRect(ctx, 12, 12, W - 24, H - 24, 26);
  ctx.stroke();
  // Gold flourishes at the four corners.
  cornerOrnament(ctx, 26, 26, 1, 1, hexRgba(t.a, 0.75));
  cornerOrnament(ctx, W - 26, 26, -1, 1, hexRgba(t.a, 0.75));
  cornerOrnament(ctx, 26, H - 26, 1, -1, hexRgba(t.a, 0.75));
  cornerOrnament(ctx, W - 26, H - 26, -1, -1, hexRgba(t.a, 0.75));

  // Crown / header decoration.
  ctx.fillStyle = t.a;
  ctx.font = EMOJI(28);
  ctx.textAlign = 'center';
  ctx.fillText(t.top, cx, 54);
  // Elegant English eyebrow line under the crown.
  ctx.fillStyle = hexRgba(t.a, 0.9);
  ctx.font = LUX(600, 12);
  drawTracked(ctx, 'OFFICIAL MEMBER CARD', cx, 78, 4);

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
  // Outer decorative ring + four gold ticks for a medallion look.
  ctx.beginPath();
  ctx.arc(cx, acy, ar + 8, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(t.a, 0.4);
  ctx.stroke();
  ctx.fillStyle = t.a;
  for (let k = 0; k < 4; k++) {
    const ang = (Math.PI / 2) * k - Math.PI / 2;
    const tx = cx + Math.cos(ang) * (ar + 8);
    const ty = acy + Math.sin(ang) * (ar + 8);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
  }

  // Name — fit on one line if it can at a readable size, else wrap to two
  // lines (like the old card did), so the full name always shows.
  const maxNameW = W - 46;
  const fit = fitName(ctx, d.name, maxNameW);
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.font = FONT(700, fit.size);
  const lineGap = fit.size + 6;
  let ny = fit.lines.length === 2 ? 280 : 292;
  ctx.save();
  ctx.shadowColor = hexRgba(t.a, 0.55);
  ctx.shadowBlur = 12;
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
  ctx.restore();

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

  // Ornamental divider (diamonds + tapering gold lines).
  ornamentalDivider(ctx, cx, 393, W / 2 - 40, hexRgba(t.a, 0.7));

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

  // Footer — luxury Roman caps, tracked, flanked by small flourishes.
  ctx.fillStyle = hexRgba(t.a, 0.92);
  ctx.font = LUX(700, 15);
  drawTracked(ctx, t.foot.replace(/\s+/g, ' '), cx, H - 24, 3);
  const footHalf = ctx.measureText(t.foot).width / 2 + 46;
  ctx.strokeStyle = hexRgba(t.a, 0.5);
  ctx.lineWidth = 1;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + dir * (footHalf - 24), H - 29);
    ctx.lineTo(cx + dir * footHalf, H - 29);
    ctx.stroke();
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// OWNER CARD — a distinct, grander design for the group's creator. Reuses the
// same fonts, frame, corner ornaments, medallion avatar and name-fit helpers as
// the id card, but with its own gold-on-black luxury layout and a prominent
// crown, so it reads as clearly above an ordinary member card.
// ─────────────────────────────────────────────────────────────────────────────
const OW = 640;
const OH = 620;
// Fixed gold palette for the owner card (independent of the id-card themes).
const GOLD = '#e8c86a';
const GOLD_HI = '#f6e3a6';

async function loadOwnerAvatar(uri?: string): Promise<Avatar | null> {
  if (!uri) return null;
  return loadImage(uri).catch(() => null);
}

function drawOwnerCard(ctx: SKRSContext2D, d: OwnerCardData, avatar: Avatar | null, phase: number): void {
  const cx = OW / 2;

  // Animation clock. `anim` gates every moving element; `ph` (0..1) drives them
  // and every element loops seamlessly (sin/cos of ph·TAU, or a full-circle
  // rotation) so the short MP4 repeats without a visible jump.
  const TAU = Math.PI * 2;
  const anim = phase >= 0;
  const ph = anim ? phase : 0;
  // A 0→1→0 easing over the loop (0 at both ends, 1 at the middle) for zoom
  // pulses that start and finish exactly matched.
  const pulse = 0.5 - 0.5 * Math.cos(ph * TAU);

  // Opaque backdrop.
  ctx.fillStyle = '#0d0a12';
  ctx.fillRect(0, 0, OW, OH);

  // Background: darkened avatar cover if present, else deep gradient. When
  // animating, the photo slowly zooms and drifts (a cinematic Ken-Burns move);
  // extra overscan (×1.24) hides the panned edges.
  if (avatar) {
    const zoom = 1.24 * (1 + (anim ? 0.1 * pulse : 0));
    const scale = Math.max(OW / avatar.width, OH / avatar.height) * zoom;
    const dw = avatar.width * scale;
    const dh = avatar.height * scale;
    const panX = anim ? Math.sin(ph * TAU) * 22 : 0;
    const panY = anim ? (Math.cos(ph * TAU) - 1) * 14 : 0;
    ctx.save();
    ctx.filter = 'blur(2px)';
    ctx.drawImage(avatar, (OW - dw) / 2 + panX, (OH - dh) / 2 + panY, dw, dh);
    ctx.restore();
  }
  const bg = ctx.createLinearGradient(0, 0, OW, OH);
  bg.addColorStop(0, avatar ? 'rgba(24,16,42,.88)' : 'rgba(24,16,42,.97)');
  bg.addColorStop(0.55, avatar ? 'rgba(12,9,20,.9)' : 'rgba(12,9,20,.98)');
  bg.addColorStop(1, avatar ? 'rgba(6,5,10,.95)' : 'rgba(6,5,10,.99)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, OW, OH);

  // Gold halo behind the crown/avatar — breathes brighter and back.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(cx, 165, 20, cx, 165, 320);
  const haloA = 0.2 + (anim ? Math.sin(ph * TAU) * 0.15 : 0);
  halo.addColorStop(0, hexRgba(GOLD, Math.max(0.06, haloA)));
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, OW, 400);
  ctx.restore();

  // Double gold frame + corner flourishes.
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexRgba(GOLD, 0.65);
  roundRect(ctx, 1.5, 1.5, OW - 3, OH - 3, 33);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(GOLD, 0.3);
  roundRect(ctx, 12, 12, OW - 24, OH - 24, 26);
  ctx.stroke();
  cornerOrnament(ctx, 26, 26, 1, 1, hexRgba(GOLD, 0.8));
  cornerOrnament(ctx, OW - 26, 26, -1, 1, hexRgba(GOLD, 0.8));
  cornerOrnament(ctx, 26, OH - 26, 1, -1, hexRgba(GOLD, 0.8));
  cornerOrnament(ctx, OW - 26, OH - 26, -1, -1, hexRgba(GOLD, 0.8));

  // Crown header — gently bobs up/down with a soft gold glow pulse.
  ctx.textAlign = 'center';
  ctx.font = EMOJI(40);
  ctx.save();
  if (anim) {
    ctx.shadowColor = hexRgba(GOLD, 0.65 + Math.sin(ph * TAU) * 0.35);
    ctx.shadowBlur = 16 + Math.sin(ph * TAU) * 12;
  }
  ctx.fillText('👑', cx, 68 + (anim ? Math.sin(ph * TAU) * 5 : 0));
  ctx.restore();
  // Elegant English eyebrow.
  ctx.fillStyle = hexRgba(GOLD, 0.92);
  ctx.font = LUX(700, 13);
  drawTracked(ctx, 'GROUP OWNER', cx, 96, 6);

  // Medallion avatar.
  const ar = 86;
  const acy = 200;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatar) {
    // Breathing zoom + tiny drift on the face (offset phase from the background
    // so the two don't pulse in lockstep). The clip keeps it a perfect circle.
    const mz = 1 + (anim ? 0.09 * (0.5 - 0.5 * Math.cos(ph * TAU + Math.PI)) : 0);
    const sz = ar * 2 * mz;
    const mdx = anim ? Math.sin(ph * TAU) * 5 : 0;
    const mdy = anim ? Math.cos(ph * TAU) * 4 : 0;
    ctx.drawImage(avatar, cx - sz / 2 + mdx, acy - sz / 2 + mdy, sz, sz);
  } else {
    const g = ctx.createLinearGradient(cx - ar, acy - ar, cx + ar, acy + ar);
    g.addColorStop(0, '#2a2350');
    g.addColorStop(1, '#15131f');
    ctx.fillStyle = g;
    ctx.fillRect(cx - ar, acy - ar, ar * 2, ar * 2);
    ctx.fillStyle = GOLD;
    ctx.font = FONT(700, 74);
    ctx.textAlign = 'center';
    ctx.fillText(d.initial || '?', cx, acy + 26);
  }
  ctx.restore();
  // Inner gold ring.
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  const ring = ctx.createLinearGradient(cx - ar, acy - ar, cx + ar, acy + ar);
  ring.addColorStop(0, GOLD_HI);
  ring.addColorStop(0.5, GOLD);
  ring.addColorStop(1, GOLD_HI);
  ctx.strokeStyle = ring;
  ctx.stroke();
  // Outer decorative ring + gold ticks (the ticks slowly rotate — a full
  // tick-spacing over the loop, so it reads as continuous spin yet loops).
  ctx.beginPath();
  ctx.arc(cx, acy, ar + 9, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(GOLD, 0.45);
  ctx.stroke();
  ctx.fillStyle = GOLD;
  const tickRot = anim ? ph * (Math.PI / 4) : 0;
  for (let k = 0; k < 8; k++) {
    const ang = (Math.PI / 4) * k + tickRot;
    const tx = cx + Math.cos(ang) * (ar + 9);
    const ty = acy + Math.sin(ang) * (ar + 9);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
    ctx.restore();
  }
  // Two bright comets sweep around the medallion per loop (opposite sides),
  // with a long glowing tail.
  if (anim) {
    ctx.save();
    ctx.shadowColor = GOLD;
    ctx.shadowBlur = 16;
    for (const base of [ph * TAU, ph * TAU + Math.PI]) {
      for (let s = 0; s < 13; s++) {
        const a = base - s * 0.08;
        ctx.beginPath();
        ctx.arc(cx, acy, ar + 9, a, a + 0.06);
        ctx.lineWidth = 3.4;
        ctx.strokeStyle = hexRgba(GOLD_HI, 0.95 - s * 0.07);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Crown badge over the avatar's lower edge.
  const badgeY = acy + ar + 2;
  ctx.beginPath();
  ctx.arc(cx, badgeY, 20, 0, Math.PI * 2);
  const bg2 = ctx.createLinearGradient(cx - 20, badgeY - 20, cx + 20, badgeY + 20);
  bg2.addColorStop(0, GOLD_HI);
  bg2.addColorStop(1, GOLD);
  ctx.fillStyle = bg2;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0d0a12';
  ctx.stroke();
  ctx.font = EMOJI(20);
  ctx.textAlign = 'center';
  ctx.fillText('👑', cx, badgeY + 7);

  // Name — gold gradient, fit to one/two lines.
  const maxNameW = OW - 60;
  const fit = fitName(ctx, d.name, maxNameW);
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.font = FONT(700, fit.size);
  const lineGap = fit.size + 6;
  let ny = fit.lines.length === 2 ? 316 : 328;
  ctx.save();
  ctx.shadowColor = hexRgba(GOLD, 0.6);
  ctx.shadowBlur = 14;
  // A bright gold band glides left↔right across the name (a live shimmer).
  const shimmer = anim ? 0.5 + Math.sin(ph * TAU) * 0.42 : 0.5;
  for (const line of fit.lines) {
    const w = Math.min(ctx.measureText(line).width, maxNameW);
    const ng = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    ng.addColorStop(0, '#ffffff');
    ng.addColorStop(Math.min(0.97, Math.max(0.03, shimmer)), GOLD_HI);
    ng.addColorStop(1, '#ffffff');
    ctx.fillStyle = ng;
    ctx.fillText(line, cx, ny);
    ny += lineGap;
  }
  ctx.restore();

  // Username.
  const userY = fit.lines.length === 2 ? ny + 2 : 356;
  ctx.direction = 'ltr';
  ctx.fillStyle = '#c4cbe0';
  ctx.font = FONT(400, 17);
  ctx.fillText(d.username, cx, userY);

  // "مالك المجموعة" pill.
  const pillY = userY + 14;
  ctx.font = FONT(700, 18);
  ctx.direction = 'rtl';
  const label = '👑 مالك المجموعة';
  const pillW = ctx.measureText(label).width + 46;
  const pillX = cx - pillW / 2;
  const rg = ctx.createLinearGradient(pillX, 0, pillX + pillW, 0);
  rg.addColorStop(0, GOLD);
  rg.addColorStop(1, GOLD_HI);
  ctx.fillStyle = rg;
  roundRect(ctx, pillX, pillY, pillW, 36, 18);
  ctx.fill();
  ctx.fillStyle = '#141018';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, pillY + 24);

  // Ornamental divider.
  const divY = pillY + 62;
  ornamentalDivider(ctx, cx, divY, OW / 2 - 44, hexRgba(GOLD, 0.72));

  // Two stat tiles: members count + creation/join date.
  const tile = (x: number, y: number, w: number, h: number, icon: string, lbl: string, value: string) => {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    roundRect(ctx, x, y, w, h, 15);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexRgba(GOLD, 0.18);
    roundRect(ctx, x, y, w, h, 15);
    ctx.stroke();
    ctx.font = EMOJI(24);
    ctx.textAlign = 'center';
    ctx.direction = 'ltr';
    ctx.fillStyle = GOLD;
    ctx.fillText(icon, x + w - 26, y + h / 2 + 9);
    const tx = x + w - 52;
    ctx.textAlign = 'right';
    ctx.direction = 'rtl';
    ctx.fillStyle = '#aab0c6';
    ctx.font = FONT(400, 12.5);
    ctx.fillText(lbl, tx, y + 25);
    ctx.fillStyle = '#ffffff';
    ctx.font = FONT(700, 17);
    const val = value.length > 20 ? value.slice(0, 19) + '…' : value;
    ctx.fillText(val, tx, y + 48);
  };

  const pad = 30;
  const gap = 12;
  const tw = (OW - pad * 2 - gap) / 2;
  const th = 66;
  let y = divY + 22;
  tile(pad + tw + gap, y, tw, th, '👥', 'عدد الأعضاء', d.members);
  tile(pad, y, tw, th, '📅', d.dateLabel, d.date);
  y += th + gap;

  // ID bar.
  ctx.fillStyle = hexRgba(GOLD, 0.1);
  roundRect(ctx, pad, y, OW - pad * 2, 48, 14);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(GOLD, 0.32);
  roundRect(ctx, pad, y, OW - pad * 2, 48, 14);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.fillStyle = GOLD;
  ctx.font = EMOJI(15);
  ctx.fillText('🆔 الآيدي', cx + 74, y + 30);
  ctx.direction = 'ltr';
  ctx.fillStyle = '#ffffff';
  ctx.font = FONT(700, 18);
  ctx.fillText(d.id, cx - 42, y + 30);

  // Footer — luxury Roman caps.
  ctx.fillStyle = hexRgba(GOLD, 0.92);
  ctx.font = LUX(700, 15);
  drawTracked(ctx, 'OWNER', cx, OH - 26, 5);
  const footHalf = ctx.measureText('OWNER').width / 2 + 50;
  ctx.strokeStyle = hexRgba(GOLD, 0.5);
  ctx.lineWidth = 1;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + dir * (footHalf - 26), OH - 31);
    ctx.lineTo(cx + dir * footHalf, OH - 31);
    ctx.stroke();
  }

  // Twinkling gold sparkles at fixed points — each scales/fades on its own
  // phase offset, so the field shimmers like light catching gilt.
  if (anim) {
    const spark = (x: number, y: number, base: number, off: number) => {
      const tw2 = 0.5 + 0.5 * Math.sin((ph + off) * TAU); // 0..1
      const s = base * (0.3 + tw2 * 0.9);
      const a = 0.3 + tw2 * 0.7;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = hexRgba(GOLD, a);
      ctx.shadowBlur = 6 * tw2;
      ctx.strokeStyle = hexRgba(GOLD_HI, a);
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
      ctx.moveTo(x - s * 0.5, y - s * 0.5); ctx.lineTo(x + s * 0.5, y + s * 0.5);
      ctx.moveTo(x - s * 0.5, y + s * 0.5); ctx.lineTo(x + s * 0.5, y - s * 0.5);
      ctx.stroke();
      ctx.restore();
    };
    const pts: [number, number, number, number][] = [
      [cx - 74, 56, 9, 0.0], [cx + 74, 60, 8, 0.5], [cx - 96, 150, 7, 0.2],
      [cx + 96, 150, 8, 0.7], [cx - 118, 250, 7, 0.35], [cx + 118, 248, 9, 0.85],
      [cx - 60, 300, 6, 0.15], [cx + 66, 302, 6, 0.6], [60, 470, 7, 0.45],
      [OW - 60, 470, 8, 0.9], [70, 560, 6, 0.25], [OW - 70, 560, 7, 0.65],
      [cx - 150, 340, 6, 0.1], [cx + 150, 340, 7, 0.55], [40, 300, 5, 0.4], [OW - 40, 300, 6, 0.8],
    ];
    for (const [x, y, b, o] of pts) spark(x, y, b, o);
  }

  // Animated diagonal gold shine sweep (video frames only; phase < 0 = static).
  if (phase >= 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bandW = 190;
    const skew = 120;
    const x = -bandW - skew + phase * (OW + bandW + skew * 2);
    const g = ctx.createLinearGradient(x, 0, x + bandW, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, hexRgba(GOLD, 0.18));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + bandW, 0);
    ctx.lineTo(x + bandW - skew, OH);
    ctx.lineTo(x - skew, OH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Render the owner card to a JPEG (fast, CPU-only, no browser). */
export async function renderOwnerCardPng(d: OwnerCardData): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(OW, OH);
  const ctx = canvas.getContext('2d');
  const avatar = await loadOwnerAvatar(d.avatarDataUri);
  drawOwnerCard(ctx, d, avatar, -1);
  return canvas.encode('jpeg', 84);
}

/**
 * Render the ANIMATED owner card (gold shine sweep) as a short looping MP4 —
 * same design as the static card, moving. CPU-only via canvas → ffmpeg (raw
 * RGBA frames), no browser. Returns null on any failure (caller falls back to
 * the still image). Mirrors renderCardMp4.
 */
export async function renderOwnerCardMp4(d: OwnerCardData): Promise<{ buffer: Buffer; ext: string } | null> {
  ensureFonts();
  lastMp4Error = '';
  const dir = await mkdtemp(join(tmpdir(), 'ownercard-')).catch(() => null);
  if (!dir) {
    lastMp4Error = 'tmpdir failed';
    return null;
  }
  const out = join(dir, 'card.mp4');
  const avatar = await loadOwnerAvatar(d.avatarDataUri);
  const canvas = createCanvas(OW, OH);
  const ctx = canvas.getContext('2d');
  // A slower, smoother 2s loop (rotation + twinkle read better than the 1s
  // id-card shine).
  const OFPS = 25;
  const OFRAMES = 50;

  return new Promise((resolve) => {
    const args = [
      '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${OW}x${OH}`,
      '-framerate', String(OFPS), '-i', '-',
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

    let i = 0;
    const pump = (): void => {
      while (i < OFRAMES) {
        drawOwnerCard(ctx, d, avatar, i / OFRAMES);
        i++;
        const img = ctx.getImageData(0, 0, OW, OH);
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

// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPER CARD — the grandest of the three. A holographic, tech-luxury design
// for the bot's developer, on a living aurora background. Beyond the owner
// card's motion it adds: a rotating hologram ring, particles orbiting the
// medallion in 3D (dimming as they pass behind), an iridescent name, a scanning
// tech grid, and — the headline effect — the whole card gently turns in space
// (a 3D "flip"), catching an edge-light glint at the narrowest point.
// ─────────────────────────────────────────────────────────────────────────────
const DW = 640;
const DH = 640;
// Holographic palette (cyan → violet → magenta) on near-black.
const HC = ['#22d3ee', '#818cf8', '#c084fc', '#f472b6'];
const HHI = '#e9d5ff';

async function loadDevAvatar(uri?: string): Promise<Avatar | null> {
  if (!uri) return null;
  return loadImage(uri).catch(() => null);
}

/** A left→right holographic gradient (cyan·indigo·violet·pink) across [x0,x1],
 *  with an optional moving highlight band position `shift` (0..1). */
function holoGradient(ctx: SKRSContext2D, x0: number, x1: number, shift = -1) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, HC[0]);
  g.addColorStop(0.34, HC[1]);
  g.addColorStop(0.67, HC[2]);
  g.addColorStop(1, HC[3]);
  if (shift >= 0) {
    const s = Math.min(0.98, Math.max(0.02, shift));
    g.addColorStop(Math.max(0.02, s - 0.06), HC[2]);
    g.addColorStop(s, '#ffffff');
    g.addColorStop(Math.min(0.98, s + 0.06), HC[3]);
  }
  return g;
}

function drawDevCard(ctx: SKRSContext2D, d: DevCardData, avatar: Avatar | null, phase: number): void {
  const cx = DW / 2;
  const TAU = Math.PI * 2;
  const anim = phase >= 0;
  const ph = anim ? phase : 0;
  const wob = anim ? Math.sin(ph * TAU) : 0; // -1..1
  const wob2 = anim ? Math.cos(ph * TAU) : 1;
  const pulse = 0.5 - 0.5 * Math.cos(ph * TAU); // 0..1..0

  // ── Solid base so squeezed edges never show through. ──
  ctx.fillStyle = '#05060d';
  ctx.fillRect(0, 0, DW, DH);

  // ── Living aurora: three big drifting blobs of holo colour (screen-blended). ──
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const blobs: [number, number, string, number][] = [
    [cx + (anim ? Math.sin(ph * TAU) * 90 : 40), 200, HC[0], 300],
    [cx + (anim ? Math.cos(ph * TAU) * 110 : -60), 430, HC[2], 340],
    [cx + (anim ? Math.sin(ph * TAU + 1.7) * 80 : 90), 560, HC[3], 260],
  ];
  for (const [bx, by, col, rad] of blobs) {
    const g = ctx.createRadialGradient(bx, by, 10, bx, by, rad);
    g.addColorStop(0, hexRgba(col, 0.22));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DW, DH);
  }
  ctx.restore();

  // ── Faint tech grid + a scan line sweeping down (behind the card). ──
  ctx.save();
  ctx.strokeStyle = hexRgba(HC[1], 0.06);
  ctx.lineWidth = 1;
  for (let gx = 40; gx < DW; gx += 40) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, DH); ctx.stroke();
  }
  for (let gy = 40; gy < DH; gy += 40) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(DW, gy); ctx.stroke();
  }
  if (anim) {
    const scanY = ph * DH;
    const sg = ctx.createLinearGradient(0, scanY - 40, 0, scanY + 40);
    sg.addColorStop(0, 'rgba(0,0,0,0)');
    sg.addColorStop(0.5, hexRgba(HC[0], 0.12));
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, scanY - 40, DW, 80);
  }
  ctx.restore();

  // ── 3D turn of the whole card: squeeze horizontally + a little tilt & bob, so
  //    it reads as a card slowly turning in space. sx never goes negative (no
  //    mirrored text); at its narrowest the card is nearly edge-on. ──
  const sx = anim ? 0.46 + 0.54 * (0.5 + 0.5 * wob2) : 1; // 0.46 … 1.0
  const tilt = anim ? wob * 0.05 : 0;
  const bob = anim ? Math.sin(ph * TAU + 1) * 5 : 0;

  ctx.save();
  ctx.translate(cx, DH / 2 + bob);
  ctx.rotate(tilt);
  ctx.scale(sx, 1);
  ctx.translate(-cx, -DH / 2);

  // Card panel background (drawn oversized so the tilt leaves no gap).
  const panel = ctx.createLinearGradient(0, 0, DW, DH);
  panel.addColorStop(0, 'rgba(14,12,28,0.92)');
  panel.addColorStop(0.55, 'rgba(9,8,18,0.95)');
  panel.addColorStop(1, 'rgba(5,5,12,0.97)');
  ctx.fillStyle = panel;
  roundRect(ctx, 6, 6, DW - 12, DH - 12, 34);
  ctx.fill();

  // Darkened avatar cover with a Ken-Burns drift, clipped to the panel.
  if (avatar) {
    ctx.save();
    roundRect(ctx, 6, 6, DW - 12, DH - 12, 34);
    ctx.clip();
    const zoom = 1.26 * (1 + (anim ? 0.1 * pulse : 0));
    const scale = Math.max(DW / avatar.width, DH / avatar.height) * zoom;
    const dw = avatar.width * scale;
    const dh = avatar.height * scale;
    ctx.globalAlpha = 0.22;
    ctx.filter = 'blur(3px)';
    ctx.drawImage(avatar, (DW - dw) / 2 + (anim ? wob * 20 : 0), (DH - dh) / 2 + (anim ? (wob2 - 1) * 12 : 0), dw, dh);
    ctx.restore();
  }

  // Holographic double frame: an outer stroke that is itself a holo gradient.
  ctx.lineWidth = 3;
  ctx.strokeStyle = holoGradient(ctx, 10, DW - 10, anim ? (0.5 + wob * 0.5) : -1);
  roundRect(ctx, 4.5, 4.5, DW - 9, DH - 9, 33);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(HC[1], 0.32);
  roundRect(ctx, 14, 14, DW - 28, DH - 28, 26);
  ctx.stroke();
  cornerOrnament(ctx, 28, 28, 1, 1, hexRgba(HC[0], 0.85));
  cornerOrnament(ctx, DW - 28, 28, -1, 1, hexRgba(HC[2], 0.85));
  cornerOrnament(ctx, 28, DH - 28, 1, -1, hexRgba(HC[2], 0.85));
  cornerOrnament(ctx, DW - 28, DH - 28, -1, -1, hexRgba(HC[3], 0.85));

  // Header emblem: code brackets </> with a pulsing neon glow that bobs.
  ctx.textAlign = 'center';
  ctx.save();
  const emY = 70 + (anim ? Math.sin(ph * TAU) * 5 : 0);
  ctx.font = FONT(700, 34);
  ctx.fillStyle = HHI;
  if (anim) {
    ctx.shadowColor = hexRgba(HC[0], 0.6 + Math.sin(ph * TAU) * 0.4);
    ctx.shadowBlur = 14 + Math.sin(ph * TAU) * 12;
  }
  ctx.direction = 'ltr';
  ctx.fillText('</>', cx, emY);
  ctx.restore();
  ctx.fillStyle = hexRgba(HC[0], 0.95);
  ctx.font = LUX(700, 13);
  drawTracked(ctx, 'DEVELOPER', cx, 100, 6);

  // ── Medallion avatar with orbiting particles + rotating hologram ring. ──
  const ar = 84;
  const acy = 208;

  // Orbiting particles that pass BEHIND the avatar (draw first, dimmed).
  const drawParticle = (a: number, rx: number, ry: number, size: number, col: string, front: boolean) => {
    const depth = (Math.sin(a) + 1) / 2; // 0 back … 1 front
    if (front !== depth > 0.5) return;
    const x = cx + Math.cos(a) * rx;
    const y = acy + Math.sin(a) * ry;
    const s = size * (0.5 + depth * 0.9);
    const al = 0.25 + depth * 0.75;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = hexRgba(col, al);
    ctx.shadowBlur = 10 * depth + 3;
    ctx.fillStyle = hexRgba(col, al);
    ctx.beginPath();
    ctx.arc(x, y, s, 0, TAU);
    ctx.fill();
    ctx.restore();
  };
  const particles: [number, number, number, number, string][] = [
    [0.0, ar + 26, 34, 3.4, HC[0]],
    [TAU / 3, ar + 26, 34, 3.0, HC[2]],
    [(TAU / 3) * 2, ar + 26, 34, 3.2, HC[3]],
    [0.9, ar + 40, 20, 2.4, HC[1]],
    [0.9 + Math.PI, ar + 40, 20, 2.6, HHI],
  ];
  const spin = anim ? ph * TAU : 0;
  for (const [off, rx, ry, s, col] of particles) drawParticle(spin + off, rx, ry, s, col, false);

  // Rotating hologram ring: coloured arc segments sweeping around the medallion.
  ctx.save();
  const segRot = anim ? ph * TAU : 0;
  for (let k = 0; k < 48; k++) {
    const a0 = (TAU / 48) * k + segRot;
    ctx.beginPath();
    ctx.arc(cx, acy, ar + 12, a0, a0 + TAU / 48);
    ctx.lineWidth = 3;
    const c = HC[k % HC.length];
    ctx.strokeStyle = hexRgba(c, 0.5 + 0.3 * Math.sin(a0 * 3));
    ctx.stroke();
  }
  ctx.restore();

  // Avatar (clipped circle) with a breathing zoom + tiny drift.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, TAU);
  ctx.closePath();
  ctx.clip();
  if (avatar) {
    const mz = 1 + (anim ? 0.09 * (0.5 - 0.5 * Math.cos(ph * TAU + Math.PI)) : 0);
    const sz = ar * 2 * mz;
    const mdx = anim ? wob * 5 : 0;
    const mdy = anim ? wob2 * 4 : 0;
    ctx.drawImage(avatar, cx - sz / 2 + mdx, acy - sz / 2 + mdy, sz, sz);
  } else {
    const g = ctx.createLinearGradient(cx - ar, acy - ar, cx + ar, acy + ar);
    g.addColorStop(0, '#1c2140');
    g.addColorStop(1, '#120f22');
    ctx.fillStyle = g;
    ctx.fillRect(cx - ar, acy - ar, ar * 2, ar * 2);
    ctx.fillStyle = HHI;
    ctx.font = FONT(700, 74);
    ctx.textAlign = 'center';
    ctx.fillText(d.initial || '?', cx, acy + 26);
  }
  ctx.restore();

  // Neon double ring around the avatar — pulses brighter and back.
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, TAU);
  ctx.lineWidth = 4;
  ctx.strokeStyle = holoGradient(ctx, cx - ar, cx + ar, anim ? 0.5 + wob * 0.5 : -1);
  ctx.save();
  if (anim) { ctx.shadowColor = hexRgba(HC[1], 0.5 + pulse * 0.4); ctx.shadowBlur = 12 + pulse * 12; }
  ctx.stroke();
  ctx.restore();

  // Particles that pass in FRONT of the avatar (draw after, bright).
  for (const [off, rx, ry, s, col] of particles) drawParticle(spin + off, rx, ry, s, col, true);

  // Emblem badge (⚡) over the medallion's lower edge.
  const badgeY = acy + ar + 2;
  ctx.beginPath();
  ctx.arc(cx, badgeY, 20, 0, TAU);
  const bg2 = ctx.createLinearGradient(cx - 20, badgeY - 20, cx + 20, badgeY + 20);
  bg2.addColorStop(0, HC[0]);
  bg2.addColorStop(1, HC[2]);
  ctx.fillStyle = bg2;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#05060d';
  ctx.stroke();
  ctx.font = EMOJI(19);
  ctx.textAlign = 'center';
  ctx.fillText('⚡', cx, badgeY + 7);

  // Name — iridescent, with a live shimmer band moving across it.
  const maxNameW = DW - 60;
  const fit = fitName(ctx, d.name, maxNameW);
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.font = FONT(700, fit.size);
  const lineGap = fit.size + 6;
  let ny = fit.lines.length === 2 ? 328 : 340;
  ctx.save();
  ctx.shadowColor = hexRgba(HC[1], 0.55);
  ctx.shadowBlur = 14;
  const shimmer = anim ? 0.5 + wob * 0.45 : -1;
  for (const line of fit.lines) {
    const w = Math.min(ctx.measureText(line).width, maxNameW);
    ctx.fillStyle = holoGradient(ctx, cx - w / 2, cx + w / 2, shimmer);
    ctx.fillText(line, cx, ny);
    ny += lineGap;
  }
  ctx.restore();

  // Username.
  const userY = fit.lines.length === 2 ? ny + 2 : 368;
  ctx.direction = 'ltr';
  ctx.fillStyle = '#c4cbe0';
  ctx.font = FONT(400, 17);
  ctx.fillText(d.username, cx, userY);

  // Role pill ("⚡ <title>") with a holo fill.
  const pillY = userY + 14;
  ctx.font = FONT(700, 18);
  ctx.direction = 'rtl';
  const label = `⚡ ${d.title}`;
  const pillW = ctx.measureText(label).width + 48;
  const pillX = cx - pillW / 2;
  ctx.fillStyle = holoGradient(ctx, pillX, pillX + pillW, anim ? 0.5 - wob * 0.5 : -1);
  roundRect(ctx, pillX, pillY, pillW, 36, 18);
  ctx.fill();
  ctx.fillStyle = '#0b0a16';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, pillY + 24);

  // Ornamental divider.
  const divY = pillY + 60;
  ornamentalDivider(ctx, cx, divY, DW / 2 - 44, hexRgba(HC[1], 0.72));

  // Tagline / signature line (centered, gently glowing).
  let y = divY + 34;
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.save();
  ctx.shadowColor = hexRgba(HC[2], anim ? 0.3 + pulse * 0.4 : 0.4);
  ctx.shadowBlur = 10;
  ctx.fillStyle = hexRgba(HHI, 0.95);
  ctx.font = FONT(700, 19);
  ctx.fillText(`✦ ${d.tagline} ✦`, cx, y);
  ctx.restore();
  y += 30;

  // ID bar.
  const pad = 34;
  ctx.fillStyle = hexRgba(HC[1], 0.1);
  roundRect(ctx, pad, y, DW - pad * 2, 48, 14);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(HC[1], 0.34);
  roundRect(ctx, pad, y, DW - pad * 2, 48, 14);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  ctx.fillStyle = HC[0];
  ctx.font = EMOJI(15);
  ctx.fillText('🆔 الآيدي', cx + 74, y + 30);
  ctx.direction = 'ltr';
  ctx.fillStyle = '#ffffff';
  ctx.font = FONT(700, 18);
  ctx.fillText(d.id, cx - 42, y + 30);

  // Footer — luxury Roman caps.
  ctx.fillStyle = hexRgba(HC[0], 0.92);
  ctx.font = LUX(700, 15);
  drawTracked(ctx, 'THE DEVELOPER', cx, DH - 28, 4);
  const footHalf = ctx.measureText('THE DEVELOPER').width / 2 + 46;
  ctx.strokeStyle = hexRgba(HC[1], 0.5);
  ctx.lineWidth = 1;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + dir * (footHalf - 24), DH - 33);
    ctx.lineTo(cx + dir * footHalf, DH - 33);
    ctx.stroke();
  }

  // Diagonal holo shine sweep across the card (video frames only).
  if (anim) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bandW = 200;
    const skew = 130;
    const bx = -bandW - skew + ph * (DW + bandW + skew * 2);
    const g = ctx.createLinearGradient(bx, 0, bx + bandW, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, hexRgba(HC[2], 0.16));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(bx, 0);
    ctx.lineTo(bx + bandW, 0);
    ctx.lineTo(bx + bandW - skew, DH);
    ctx.lineTo(bx - skew, DH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.restore(); // end 3D-turn transform

  // ── Edge-light glint: when the card is near edge-on (sx small), a bright
  //    vertical bar flashes down its center — sells the flip. Drawn untransformed. ──
  if (anim && sx < 0.62) {
    const edge = (0.62 - sx) / 0.62; // 0..~0.35 → normalize
    const a = Math.min(0.5, edge * 1.4);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halfW = 30 + edge * 40;
    const g = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, hexRgba(HHI, a));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - halfW, 40, halfW * 2, DH - 80);
    ctx.restore();
  }

  // ── Foreground twinkling sparkles over the whole scene. ──
  if (anim) {
    const spark = (x: number, y: number, base: number, off: number, col: string) => {
      const tw2 = 0.5 + 0.5 * Math.sin((ph + off) * TAU);
      const s = base * (0.3 + tw2 * 0.9);
      const a = 0.25 + tw2 * 0.7;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = hexRgba(col, a);
      ctx.shadowBlur = 6 * tw2;
      ctx.strokeStyle = hexRgba(col, a);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
      ctx.stroke();
      ctx.restore();
    };
    const pts: [number, number, number, number, string][] = [
      [70, 120, 7, 0.0, HC[0]], [DW - 70, 130, 8, 0.5, HC[2]], [96, 250, 6, 0.2, HC[3]],
      [DW - 96, 250, 7, 0.7, HC[1]], [56, 430, 7, 0.35, HC[0]], [DW - 56, 430, 8, 0.85, HC[2]],
      [80, 560, 6, 0.15, HC[3]], [DW - 80, 560, 7, 0.6, HC[1]], [cx - 150, 500, 6, 0.4, HHI],
      [cx + 150, 500, 6, 0.8, HHI],
    ];
    for (const [x, y, b, o, c] of pts) spark(x, y, b, o, c);
  }
}

/** Render the developer card to a JPEG (fast, CPU-only, no browser). */
export async function renderDevCardPng(d: DevCardData): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(DW, DH);
  const ctx = canvas.getContext('2d');
  const avatar = await loadDevAvatar(d.avatarDataUri);
  drawDevCard(ctx, d, avatar, -1);
  return canvas.encode('jpeg', 86);
}

/**
 * Render the ANIMATED developer card as a short looping MP4 (orbits + hologram +
 * 3D turn). CPU-only via canvas → ffmpeg (raw RGBA frames), no browser. Returns
 * null on any failure (caller falls back to the still image). Mirrors the owner
 * card renderer.
 */
export async function renderDevCardMp4(d: DevCardData): Promise<{ buffer: Buffer; ext: string } | null> {
  ensureFonts();
  lastMp4Error = '';
  const dir = await mkdtemp(join(tmpdir(), 'devcard-')).catch(() => null);
  if (!dir) {
    lastMp4Error = 'tmpdir failed';
    return null;
  }
  const out = join(dir, 'card.mp4');
  const avatar = await loadDevAvatar(d.avatarDataUri);
  const canvas = createCanvas(DW, DH);
  const ctx = canvas.getContext('2d');
  // A smooth ~2.4s loop — the turn + orbits read better slower.
  const DFPS = 25;
  const DFRAMES = 60;

  return new Promise((resolve) => {
    const args = [
      '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${DW}x${DH}`,
      '-framerate', String(DFPS), '-i', '-',
      '-an', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', out,
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

    let i = 0;
    const pump = (): void => {
      while (i < DFRAMES) {
        drawDevCard(ctx, d, avatar, i / DFRAMES);
        i++;
        const img = ctx.getImageData(0, 0, DW, DH);
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
