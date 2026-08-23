import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { createLogger } from '../../core/logger';
import type { IdCardImageData, CardTheme, OwnerCardData } from './image';

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

function drawOwnerCard(ctx: SKRSContext2D, d: OwnerCardData, avatar: Avatar | null): void {
  const cx = OW / 2;

  // Opaque backdrop.
  ctx.fillStyle = '#0d0a12';
  ctx.fillRect(0, 0, OW, OH);

  // Background: darkened avatar cover if present, else deep gradient.
  if (avatar) {
    const scale = Math.max(OW / avatar.width, OH / avatar.height) * 1.15;
    const dw = avatar.width * scale;
    const dh = avatar.height * scale;
    ctx.save();
    ctx.filter = 'blur(2px)';
    ctx.drawImage(avatar, (OW - dw) / 2, (OH - dh) / 2, dw, dh);
    ctx.restore();
  }
  const bg = ctx.createLinearGradient(0, 0, OW, OH);
  bg.addColorStop(0, avatar ? 'rgba(24,16,42,.88)' : 'rgba(24,16,42,.97)');
  bg.addColorStop(0.55, avatar ? 'rgba(12,9,20,.9)' : 'rgba(12,9,20,.98)');
  bg.addColorStop(1, avatar ? 'rgba(6,5,10,.95)' : 'rgba(6,5,10,.99)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, OW, OH);

  // Gold halo behind the crown/avatar.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(cx, 165, 20, cx, 165, 320);
  halo.addColorStop(0, hexRgba(GOLD, 0.18));
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

  // Crown header.
  ctx.textAlign = 'center';
  ctx.font = EMOJI(40);
  ctx.fillText('👑', cx, 68);
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
    ctx.drawImage(avatar, cx - ar, acy - ar, ar * 2, ar * 2);
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
  // Outer decorative ring + gold ticks.
  ctx.beginPath();
  ctx.arc(cx, acy, ar + 9, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(GOLD, 0.45);
  ctx.stroke();
  ctx.fillStyle = GOLD;
  for (let k = 0; k < 8; k++) {
    const ang = (Math.PI / 4) * k;
    const tx = cx + Math.cos(ang) * (ar + 9);
    const ty = acy + Math.sin(ang) * (ar + 9);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
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
  for (const line of fit.lines) {
    const w = Math.min(ctx.measureText(line).width, maxNameW);
    const ng = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    ng.addColorStop(0, '#ffffff');
    ng.addColorStop(0.5, GOLD);
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
}

/** Render the owner card to a JPEG (fast, CPU-only, no browser). */
export async function renderOwnerCardPng(d: OwnerCardData): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(OW, OH);
  const ctx = canvas.getContext('2d');
  const avatar = await loadOwnerAvatar(d.avatarDataUri);
  drawOwnerCard(ctx, d, avatar);
  return canvas.encode('jpeg', 84);
}
