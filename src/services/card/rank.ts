import { createCanvas, type Image } from '@napi-rs/canvas';
import {
  ensureFonts,
  FONT,
  LUX,
  GOLD,
  hexRgba,
  roundRect,
  drawTracked,
  drawLuxuryFrame,
  drawLuxuryBackground,
} from './lux';

export interface RankCardData {
  name: string;
  level: number;
  xp: number; // total XP
  xpFloor: number; // XP at the start of the current level
  xpNext: number; // XP needed for the next level
  messages: number;
  rank?: string; // optional role/rank label
  avatar?: Image | null;
  initial: string;
  handle?: string;
}

const W = 820;
const H = 400;

const fmtNum = (n: number): string => n.toLocaleString('en-US');

export async function renderRankCard(d: RankCardData): Promise<Buffer> {
  ensureFonts();
  const t = GOLD;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawLuxuryBackground(ctx, W, H, t, d.avatar ?? undefined);
  drawLuxuryFrame(ctx, W, H, t);

  const cx = W / 2;

  // Eyebrow.
  ctx.fillStyle = hexRgba(t.a, 0.92);
  ctx.font = LUX(700, 14);
  drawTracked(ctx, '✦  MEMBER RANK  ✦', cx, 52, 5);

  // Avatar medallion on the left.
  const ar = 74;
  const acx = 120;
  const acy = 190;
  ctx.save();
  ctx.beginPath();
  ctx.arc(acx, acy, ar, 0, Math.PI * 2);
  ctx.clip();
  if (d.avatar) {
    const s = Math.max((ar * 2) / d.avatar.width, (ar * 2) / d.avatar.height);
    ctx.drawImage(d.avatar, acx - (d.avatar.width * s) / 2, acy - (d.avatar.height * s) / 2, d.avatar.width * s, d.avatar.height * s);
  } else {
    const g = ctx.createLinearGradient(acx - ar, acy - ar, acx + ar, acy + ar);
    g.addColorStop(0, hexRgba(t.a, 0.3));
    g.addColorStop(1, 'rgba(20,16,30,0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(acx - ar, acy - ar, ar * 2, ar * 2);
    ctx.fillStyle = t.a;
    ctx.font = FONT(700, 64);
    ctx.textAlign = 'center';
    ctx.fillText(d.initial || '?', acx, acy + 22);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(acx, acy, ar, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = t.a;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(acx, acy, ar + 8, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(t.a, 0.4);
  ctx.stroke();
  ctx.fillStyle = t.a;
  for (let k = 0; k < 4; k++) {
    const ang = (Math.PI / 2) * k - Math.PI / 2;
    ctx.save();
    ctx.translate(acx + Math.cos(ang) * (ar + 8), acy + Math.sin(ang) * (ar + 8));
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
  }

  // Right region.
  const xR = W - 44;
  const maxW = xR - (acx + ar) - 30;

  // Name.
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';
  let size = 34;
  for (; size >= 22; size--) {
    ctx.font = FONT(700, size);
    if (ctx.measureText(d.name).width <= maxW) break;
  }
  let name = d.name;
  if (ctx.measureText(name).width > maxW) {
    while (name.length > 1 && ctx.measureText(name + '…').width > maxW) name = name.slice(0, -1);
    name += '…';
  }
  const nw = Math.min(ctx.measureText(name).width, maxW);
  const ng = ctx.createLinearGradient(xR - nw, 0, xR, 0);
  ng.addColorStop(0, '#ffffff');
  ng.addColorStop(0.5, t.a2);
  ng.addColorStop(1, t.a);
  ctx.save();
  ctx.shadowColor = hexRgba(t.a, 0.5);
  ctx.shadowBlur = 10;
  ctx.fillStyle = ng;
  ctx.fillText(name, xR, 118);
  ctx.restore();

  // Rank label (optional).
  if (d.rank) {
    ctx.font = FONT(400, 16);
    ctx.fillStyle = '#c7ccdd';
    ctx.fillText(d.rank, xR, 148);
  }

  // Big LEVEL number.
  ctx.textAlign = 'left';
  ctx.direction = 'ltr';
  ctx.font = LUX(700, 22);
  ctx.fillStyle = hexRgba(t.a, 0.9);
  const lx = acx + ar + 30;
  ctx.fillText('LEVEL', lx, 200);
  const lvW = ctx.measureText('LEVEL ').width;
  ctx.font = FONT(700, 40);
  ctx.fillStyle = t.a2;
  ctx.save();
  ctx.shadowColor = hexRgba(t.a, 0.6);
  ctx.shadowBlur = 14;
  ctx.fillText(String(d.level), lx + lvW + 6, 206);
  ctx.restore();

  // XP progress bar.
  const span = Math.max(1, d.xpNext - d.xpFloor);
  const prog = Math.max(0, Math.min(1, (d.xp - d.xpFloor) / span));
  const barX = lx;
  const barW = xR - barX;
  const barY = 236;
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  roundRect(ctx, barX, barY, barW, 14, 7);
  ctx.fill();
  const pg = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  pg.addColorStop(0, t.a);
  pg.addColorStop(1, t.a2);
  ctx.fillStyle = pg;
  roundRect(ctx, barX, barY, Math.max(14, barW * prog), 14, 7);
  ctx.fill();
  // XP text under the bar.
  ctx.font = FONT(400, 14);
  ctx.fillStyle = '#aeb4c8';
  ctx.textAlign = 'left';
  ctx.direction = 'ltr';
  ctx.fillText(`${fmtNum(d.xp - d.xpFloor)} / ${fmtNum(span)} XP`, barX, barY + 34);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(prog * 100)}%`, xR, barY + 34);

  // Stat chips: total XP + messages.
  const chip = (x: number, w: number, icon: string, label: string, value: string): void => {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    roundRect(ctx, x, 296, w, 56, 14);
    ctx.fill();
    ctx.strokeStyle = hexRgba(t.a, 0.18);
    ctx.lineWidth = 1;
    roundRect(ctx, x, 296, w, 56, 14);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.direction = 'ltr';
    ctx.font = `20px NotoEmoji`;
    ctx.fillStyle = t.a;
    ctx.fillText(icon, x + 14, 330);
    ctx.font = FONT(400, 12.5);
    ctx.fillStyle = '#aab0c6';
    ctx.fillText(label, x + 46, 320);
    ctx.font = FONT(700, 17);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(value, x + 46, 342);
  };
  const chipW = (barW - 14) / 2;
  chip(barX, chipW, '🔥', 'مجموع النقاط', fmtNum(d.xp));
  chip(barX + chipW + 14, chipW, '💬', 'الرسائل', fmtNum(d.messages));

  // Footer handle.
  if (d.handle) {
    ctx.fillStyle = hexRgba(t.a, 0.85);
    ctx.font = LUX(600, 13);
    drawTracked(ctx, d.handle.toUpperCase(), cx, H - 20, 2);
  }

  return await canvas.encode('jpeg', 86);
}
