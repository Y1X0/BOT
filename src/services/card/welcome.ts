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
  ornamentalDivider,
} from './lux';

export interface WelcomeCardData {
  name: string;
  group?: string;
  memberNo?: number; // "member #N"
  avatar?: Image | null;
  initial: string;
  handle?: string;
  farewell?: boolean; // render a goodbye card instead
}

const W = 760;
const H = 460;

export async function renderWelcomeCard(d: WelcomeCardData): Promise<Buffer> {
  ensureFonts();
  const t = GOLD;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawLuxuryBackground(ctx, W, H, t, d.avatar ?? undefined);
  drawLuxuryFrame(ctx, W, H, t);

  const cx = W / 2;

  // Eyebrow.
  ctx.fillStyle = hexRgba(t.a, 0.92);
  ctx.font = LUX(700, 18);
  drawTracked(ctx, d.farewell ? '✦  FAREWELL  ✦' : '✦  WELCOME  ✦', cx, 62, 6);
  ornamentalDivider(ctx, cx, 82, W / 2 - 60, hexRgba(t.a, 0.6));

  // Avatar medallion.
  const ar = 78;
  const acy = 186;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, Math.PI * 2);
  ctx.clip();
  if (d.avatar) {
    const s = Math.max((ar * 2) / d.avatar.width, (ar * 2) / d.avatar.height);
    const dw = d.avatar.width * s;
    const dh = d.avatar.height * s;
    ctx.drawImage(d.avatar, cx - dw / 2, acy - dh / 2, dw, dh);
  } else {
    const g = ctx.createLinearGradient(cx - ar, acy - ar, cx + ar, acy + ar);
    g.addColorStop(0, hexRgba(t.a, 0.3));
    g.addColorStop(1, 'rgba(20,16,30,0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - ar, acy - ar, ar * 2, ar * 2);
    ctx.fillStyle = t.a;
    ctx.font = FONT(700, 68);
    ctx.textAlign = 'center';
    ctx.fillText(d.initial || '?', cx, acy + 24);
  }
  ctx.restore();
  // Rings + ticks.
  ctx.beginPath();
  ctx.arc(cx, acy, ar, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = t.a;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, acy, ar + 8, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = hexRgba(t.a, 0.4);
  ctx.stroke();
  ctx.fillStyle = t.a;
  for (let k = 0; k < 4; k++) {
    const ang = (Math.PI / 2) * k - Math.PI / 2;
    ctx.save();
    ctx.translate(cx + Math.cos(ang) * (ar + 8), acy + Math.sin(ang) * (ar + 8));
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
  }

  // Name (gradient + glow).
  const maxW = W - 80;
  let size = 40;
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  for (; size >= 24; size--) {
    ctx.font = FONT(700, size);
    if (ctx.measureText(d.name).width <= maxW) break;
  }
  let name = d.name;
  if (ctx.measureText(name).width > maxW) {
    while (name.length > 1 && ctx.measureText(name + '…').width > maxW) name = name.slice(0, -1);
    name += '…';
  }
  const nw = Math.min(ctx.measureText(name).width, maxW);
  const ng = ctx.createLinearGradient(cx - nw / 2, 0, cx + nw / 2, 0);
  ng.addColorStop(0, '#ffffff');
  ng.addColorStop(0.5, t.a);
  ng.addColorStop(1, '#ffffff');
  ctx.save();
  ctx.shadowColor = hexRgba(t.a, 0.55);
  ctx.shadowBlur = 12;
  ctx.fillStyle = ng;
  ctx.fillText(name, cx, 322);
  ctx.restore();

  // Sub line: "أهلاً بك في {group}" / "غادر {group}".
  if (d.group) {
    ctx.direction = 'rtl';
    ctx.font = FONT(400, 19);
    ctx.fillStyle = '#c7ccdd';
    const verb = d.farewell ? 'غادر' : 'أهلاً بك في';
    ctx.fillText(`${verb} ${d.group}`, cx, 356);
  }

  // Member number pill.
  if (d.memberNo && !d.farewell) {
    const label = `👑 العضو رقم ${d.memberNo}`;
    ctx.font = FONT(700, 18);
    const pw = ctx.measureText(label).width + 44;
    const px = cx - pw / 2;
    const py = 376;
    const rg = ctx.createLinearGradient(px, 0, px + pw, 0);
    rg.addColorStop(0, t.a);
    rg.addColorStop(1, t.a2);
    ctx.fillStyle = rg;
    roundRect(ctx, px, py, pw, 36, 18);
    ctx.fill();
    ctx.fillStyle = '#141018';
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, py + 24);
  }

  // Footer handle.
  if (d.handle) {
    ctx.fillStyle = hexRgba(t.a, 0.85);
    ctx.font = LUX(600, 14);
    drawTracked(ctx, d.handle.toUpperCase(), cx, H - 22, 2);
  }

  return await canvas.encode('jpeg', 86);
}
