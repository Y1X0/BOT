import { createCanvas, loadImage, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import { createLogger } from '../../core/logger';
import {
  ensureFonts,
  FONT,
  LUX,
  EMOJI,
  GOLD,
  hexRgba,
  roundRect,
  drawTracked,
  drawLuxuryFrame,
  drawLuxuryBackground,
} from './lux';

const log = createLogger('card:song');

export interface SongCardData {
  title: string;
  uploader?: string;
  duration?: string; // pre-formatted (e.g. "3:45")
  requester?: string; // name or "تلقائي"
  coverUrl?: string;
  handle?: string; // bot @handle for the footer
}

const W = 840;
const H = 440;

async function loadCover(url?: string): Promise<Image | null> {
  if (!url) return null;
  try {
    if (/^https?:/.test(url)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return await loadImage(buf);
    }
    return await loadImage(url);
  } catch (err) {
    log.debug({ err }, 'cover load failed');
    return null;
  }
}

/** Shrink the font until the title fits one line, else return it for truncation. */
function fitTitle(ctx: SKRSContext2D, title: string, maxW: number): number {
  for (let s = 34; s >= 22; s--) {
    ctx.font = FONT(700, s);
    if (ctx.measureText(title).width <= maxW) return s;
  }
  return 22;
}

export async function renderSongCard(d: SongCardData): Promise<Buffer> {
  ensureFonts();
  const t = GOLD;
  const cover = await loadCover(d.coverUrl);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawLuxuryBackground(ctx, W, H, t, cover);
  drawLuxuryFrame(ctx, W, H, t);

  const cx = W / 2;

  // Eyebrow: NOW PLAYING.
  ctx.fillStyle = hexRgba(t.a, 0.92);
  ctx.font = LUX(700, 15);
  drawTracked(ctx, '♪  NOW PLAYING  ♪', cx, 56, 4);

  // Cover art — rounded square on the left, gold framed.
  const cs = 250;
  const cxImg = 44;
  const cyImg = 96;
  ctx.save();
  roundRect(ctx, cxImg, cyImg, cs, cs, 20);
  ctx.clip();
  if (cover) {
    const scale = Math.max(cs / cover.width, cs / cover.height);
    const dw = cover.width * scale;
    const dh = cover.height * scale;
    ctx.drawImage(cover, cxImg + (cs - dw) / 2, cyImg + (cs - dh) / 2, dw, dh);
  } else {
    const g = ctx.createLinearGradient(cxImg, cyImg, cxImg + cs, cyImg + cs);
    g.addColorStop(0, hexRgba(t.a, 0.25));
    g.addColorStop(1, 'rgba(20,16,30,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(cxImg, cyImg, cs, cs);
    ctx.fillStyle = t.a;
    ctx.font = EMOJI(80);
    ctx.textAlign = 'center';
    ctx.fillText('🎵', cxImg + cs / 2, cyImg + cs / 2 + 28);
  }
  ctx.restore();
  ctx.strokeStyle = hexRgba(t.a, 0.7);
  ctx.lineWidth = 2.5;
  roundRect(ctx, cxImg, cyImg, cs, cs, 20);
  ctx.stroke();

  // Text region on the right (RTL, right-aligned).
  const xR = W - 44;
  const maxTextW = xR - (cxImg + cs) - 28;
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';

  // Title (gold-gradient, glowing).
  const size = fitTitle(ctx, d.title || '—', maxTextW);
  let title = d.title || '—';
  ctx.font = FONT(700, size);
  if (ctx.measureText(title).width > maxTextW) {
    while (title.length > 1 && ctx.measureText(title + '…').width > maxTextW) title = title.slice(0, -1);
    title += '…';
  }
  const tw = Math.min(ctx.measureText(title).width, maxTextW);
  const ng = ctx.createLinearGradient(xR - tw, 0, xR, 0);
  ng.addColorStop(0, '#ffffff');
  ng.addColorStop(0.5, t.a2);
  ng.addColorStop(1, t.a);
  ctx.save();
  ctx.shadowColor = hexRgba(t.a, 0.5);
  ctx.shadowBlur = 12;
  ctx.fillStyle = ng;
  ctx.fillText(title, xR, 150);
  ctx.restore();

  // Meta rows: label + value with a small gold icon on the right.
  const row = (y: number, icon: string, label: string, value: string): void => {
    ctx.textAlign = 'right';
    ctx.direction = 'rtl';
    ctx.font = EMOJI(20);
    ctx.fillStyle = t.a;
    ctx.fillText(icon, xR, y);
    ctx.font = FONT(400, 17);
    ctx.fillStyle = '#aeb4c8';
    const lw = ctx.measureText(` ${label}: `).width;
    ctx.fillText(` ${label}: `, xR - 30, y);
    ctx.font = FONT(700, 18);
    ctx.fillStyle = '#ffffff';
    let v = value || '—';
    const vmax = maxTextW - 30 - lw;
    if (ctx.measureText(v).width > vmax) {
      while (v.length > 1 && ctx.measureText(v + '…').width > vmax) v = v.slice(0, -1);
      v += '…';
    }
    ctx.fillText(v, xR - 30 - lw, y);
  };
  row(210, '🎙', 'القناة', d.uploader || '—');
  row(252, '⏱', 'المدة', d.duration || '—');
  row(294, '👤', 'طلب', d.requester || 'تلقائي');

  // Decorative progress bar.
  const barY = 356;
  const barX = cxImg + cs + 28;
  const barW = xR - barX;
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  roundRect(ctx, barX, barY, barW, 6, 3);
  ctx.fill();
  const pg = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  pg.addColorStop(0, t.a);
  pg.addColorStop(1, t.a2);
  ctx.fillStyle = pg;
  roundRect(ctx, barX, barY, barW * 0.42, 6, 3);
  ctx.fill();
  ctx.fillStyle = t.a;
  ctx.beginPath();
  ctx.arc(barX + barW * 0.42, barY + 3, 6, 0, Math.PI * 2);
  ctx.fill();

  // Footer handle.
  if (d.handle) {
    ctx.fillStyle = hexRgba(t.a, 0.85);
    ctx.font = LUX(600, 14);
    drawTracked(ctx, d.handle.toUpperCase(), cx, H - 22, 2);
  }

  return canvas.encode('jpeg', 86);
}
