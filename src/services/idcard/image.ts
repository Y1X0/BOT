import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { getBrowser } from '../pdf/browser';
import { fontFaceCss } from '../pdf/fonts';
import { createLogger } from '../../core/logger';

const vlog = createLogger('idcard:video');

export interface IdCardImageData {
  name: string;
  username: string;
  id: string;
  rank: string;
  stats: string;
  title: string;
  level: string;
  xp: string;
  messages: string;
  interaction: string;
  joined: string;
  avatarDataUri?: string; // base64 profile photo, if available
  initial: string; // fallback avatar letter
}

const esc = (s: string): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A color theme for the card. Alpha is applied via 8-digit hex (Chromium ok). */
export interface CardTheme {
  id: string;
  label: string;
  a: string; // accent
  a2: string; // accent light
  bg1: string; // tint gradient top (rgba)
  bg2: string; // tint gradient bottom (rgba)
  ph1: string; // placeholder-avatar gradient
  ph2: string;
  top: string; // header decoration
  foot: string; // footer label
}

export const CARD_THEMES: CardTheme[] = [
  { id: 'gold', label: '👑 ذهبي', a: '#e8c86a', a2: '#f6e3a6', bg1: 'rgba(20,14,40,.86)', bg2: 'rgba(8,8,16,.94)', ph1: '#2a2350', ph2: '#15131f', top: '👑 ✦ 👑', foot: 'V I P' },
  { id: 'neon', label: '💎 نيون', a: '#37e0ff', a2: '#a8f6ff', bg1: 'rgba(6,20,34,.88)', bg2: 'rgba(4,6,16,.95)', ph1: '#10314a', ph2: '#0a1420', top: '⟨ ✦ ⟩', foot: 'C Y B E R' },
  { id: 'emerald', label: '🌿 زمرّد', a: '#4be39a', a2: '#bff5cf', bg1: 'rgba(8,34,24,.88)', bg2: 'rgba(4,14,10,.95)', ph1: '#123f2d', ph2: '#0a1a12', top: '❦ ✦ ❦', foot: 'E L I T E' },
  { id: 'sunset', label: '🌅 غروب', a: '#ff8a5c', a2: '#ffd08a', bg1: 'rgba(42,16,28,.88)', bg2: 'rgba(16,8,14,.95)', ph1: '#3a1626', ph2: '#180a12', top: '☀ ✦ ☀', foot: 'S T A R' },
  { id: 'ocean', label: '🌊 محيط', a: '#5aa9ff', a2: '#b8dbff', bg1: 'rgba(10,24,46,.88)', bg2: 'rgba(5,10,22,.95)', ph1: '#123256', ph2: '#0a1526', top: '≈ ✦ ≈', foot: 'P R O' },
  { id: 'rose', label: '🌸 وردي', a: '#ff7ab0', a2: '#ffc2dd', bg1: 'rgba(42,14,30,.88)', bg2: 'rgba(18,8,14,.95)', ph1: '#3a1428', ph2: '#180a12', top: '✿ ✦ ✿', foot: 'V I P' },
  { id: 'mono', label: '⚪ فضّي', a: '#d9d9e0', a2: '#ffffff', bg1: 'rgba(28,28,36,.9)', bg2: 'rgba(10,10,14,.96)', ph1: '#2a2a34', ph2: '#131318', top: '◆ ✦ ◆', foot: 'M E M B E R' },
];

export const CARD_THEME_IDS = CARD_THEMES.map((t) => t.id);

/** djb2-ish hash so a given id maps to a stable theme. */
function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Resolve which theme to use. mode: 'auto' → a stable per-user theme (each
 * member gets a different look, so the group sees variety); 'random' → a
 * different one each time; a specific theme id → that theme; else default.
 */
export function resolveCardTheme(mode: string | null | undefined, userId: string, roll: number): string {
  const m = mode || 'auto';
  if (m === 'random') return CARD_THEME_IDS[roll % CARD_THEME_IDS.length];
  if (m === 'auto') return CARD_THEME_IDS[hashId(userId) % CARD_THEME_IDS.length];
  return CARD_THEME_IDS.includes(m) ? m : CARD_THEME_IDS[0];
}

/** A row of the stats grid. */
function stat(icon: string, label: string, value: string): string {
  return `<div class="stat"><div class="ico">${icon}</div><div class="col"><div class="lab">${esc(label)}</div><div class="val">${esc(value)}</div></div></div>`;
}

interface CardOpts {
  animated?: boolean; // add a shine sweep + glow pulse (for the video card)
  premium?: boolean; // add a PREMIUM badge (Telegram Premium members)
}

function buildCardHtml(d: IdCardImageData, theme: CardTheme, opts: CardOpts = {}): string {
  const anim = !!opts.animated;
  const prem = !!opts.premium;
  const avatar = d.avatarDataUri
    ? `<img class="ava" src="${d.avatarDataUri}" alt="">`
    : `<div class="ava ava-ph">${esc(d.initial)}</div>`;
  const bg = d.avatarDataUri ? `background-image:url('${d.avatarDataUri}');` : '';
  const t = theme;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaceCss()}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{background:${anim ? t.bg2.replace(/rgba\(([^)]+),[^,]+\)/, 'rgb($1)') : 'transparent'};}
${anim ? 'body{display:flex;align-items:center;justify-content:center;min-height:100vh;}' : ''}
.card{width:640px;position:relative;overflow:hidden;border-radius:34px;
  font-family:'Cairo','Amiri',sans-serif;color:#fff;direction:rtl;
  border:2px solid ${t.a}8c;box-shadow:0 24px 70px rgba(0,0,0,.6);${anim ? `animation:glow 2.6s ease-in-out infinite;` : ''}}
${anim ? `
@keyframes glow{0%,100%{box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 0 0 ${t.a}00;}50%{box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 34px 2px ${t.a}66;}}
@keyframes sweep{0%{transform:translateX(-160%) rotate(20deg);}100%{transform:translateX(160%) rotate(20deg);}}
@keyframes nameshift{0%,100%{filter:brightness(1);}50%{filter:brightness(1.25);}}
.shine{position:absolute;top:0;bottom:0;width:55%;left:-30%;pointer-events:none;z-index:5;
  background:linear-gradient(90deg,transparent,${t.a}22,#ffffff33,${t.a}22,transparent);
  animation:sweep 3s ease-in-out infinite;}
.name{animation:nameshift 2.6s ease-in-out infinite;}
.premium{position:absolute;top:14px;left:14px;z-index:6;padding:5px 13px;border-radius:999px;font-size:13px;font-weight:700;
  color:#141018;background:linear-gradient(90deg,${t.a},${t.a2});box-shadow:0 4px 14px ${t.a}66;letter-spacing:1px;}
` : ''}
.bgimg{position:absolute;inset:0;${bg}background-size:cover;background-position:center;filter:blur(26px) brightness(.42) saturate(1.2);transform:scale(1.25);}
.tint{position:absolute;inset:0;background:linear-gradient(160deg,${t.bg1},${t.bg2});}
.frame{position:relative;padding:36px 34px 30px;}
.crown{text-align:center;font-size:30px;letter-spacing:8px;color:${t.a};text-shadow:0 0 18px ${t.a}99;}
.head{display:flex;flex-direction:column;align-items:center;margin-top:6px;}
.ava{width:150px;height:150px;border-radius:50%;object-fit:cover;border:4px solid ${t.a};
  box-shadow:0 0 0 6px ${t.a}29,0 10px 30px rgba(0,0,0,.55);background:#222;}
.ava-ph{display:flex;align-items:center;justify-content:center;font-size:64px;font-weight:700;color:${t.a};background:linear-gradient(145deg,${t.ph1},${t.ph2});}
.name{font-size:34px;font-weight:700;margin-top:16px;text-align:center;line-height:1.25;
  background:linear-gradient(90deg,#ffffff,${t.a},#ffffff);-webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:0 2px 14px ${t.a}40;max-width:100%;}
.uname{font-size:17px;color:#b9c0d4;margin-top:4px;direction:ltr;}
.rankpill{margin:14px auto 2px;display:inline-block;padding:7px 20px;border-radius:999px;font-size:18px;font-weight:700;
  color:#141018;background:linear-gradient(90deg,${t.a},${t.a2});box-shadow:0 6px 18px ${t.a}52;}
.rankwrap{text-align:center;}
.divider{height:1px;margin:20px 2px 16px;background:linear-gradient(90deg,transparent,${t.a}8c,transparent);}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;}
.stat{display:flex;align-items:center;gap:11px;background:rgba(255,255,255,.055);border:1px solid ${t.a}29;
  border-radius:16px;padding:11px 13px;}
.stat .ico{font-size:23px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));}
.stat .col{min-width:0;flex:1;}
.stat .lab{font-size:12.5px;color:#aab0c6;}
.stat .val{font-size:16.5px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.full{grid-column:1 / -1;}
.idbar{grid-column:1 / -1;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:9px;
  background:${t.a}1a;border:1px solid ${t.a}4d;border-radius:14px;padding:10px;}
.idbar .k{font-size:14px;color:${t.a};}
.idbar .v{font-size:18px;font-weight:700;letter-spacing:1px;direction:ltr;}
.foot{text-align:center;margin-top:18px;font-size:15px;letter-spacing:6px;color:${t.a}d9;}
</style></head><body>
<div class="card"><div class="bgimg"></div><div class="tint"></div>
  ${anim ? '<div class="shine"></div>' : ''}
  ${prem ? '<div class="premium">PREMIUM 💎</div>' : ''}
  <div class="frame">
    <div class="crown">${t.top}</div>
    <div class="head">${avatar}
      <div class="name">${esc(d.name)}</div>
      <div class="uname">${esc(d.username)}</div>
    </div>
    <div class="rankwrap"><span class="rankpill">${esc(d.rank)}</span></div>
    <div class="divider"></div>
    <div class="grid">
      ${stat('🛡', 'الحالة', d.stats)}
      ${stat('🎖', 'اللقب', d.title)}
      ${stat('⭐', 'المستوى', d.level)}
      ${stat('🔥', 'النقاط', d.xp)}
      ${stat('💬', 'الرسائل', d.messages)}
      ${stat('⚡', 'التفاعل', d.interaction)}
      <div class="stat full">${'<div class="ico">📅</div>'}<div class="col"><div class="lab">تاريخ الانضمام</div><div class="val">${esc(d.joined)}</div></div></div>
      <div class="idbar"><span class="k">🆔 الآيدي</span><span class="v">${esc(d.id)}</span></div>
    </div>
    <div class="foot">${t.foot}</div>
  </div>
</div>
</body></html>`;
}

/** Render the profile card to a crisp PNG buffer. Throws if Chromium is unavailable. */
export async function renderIdCardImage(d: IdCardImageData, themeId?: string): Promise<Buffer> {
  const theme = CARD_THEMES.find((x) => x.id === themeId) ?? CARD_THEMES[0];
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 680, height: 1000 }, deviceScaleFactor: 2 });
  try {
    // 'load' (not 'networkidle') so an embedded-only page never stalls waiting
    // for network quiet; then explicitly wait for the embedded fonts to shape.
    await page.setContent(buildCardHtml(d, theme), { waitUntil: 'load', timeout: 20_000 });
    // Wait for embedded fonts to finish shaping (string form avoids DOM types).
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => undefined);
    const el = await page.$('.card');
    const shot = await (el ?? page).screenshot({ type: 'png', omitBackground: true });
    return Buffer.from(shot);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Render an ANIMATED profile card (shine sweep + glow) as a short looping MP4,
 * for Telegram Premium members. Records the animated page with Playwright, then
 * transcodes webm→mp4 with ffmpeg. Returns null on any failure (the caller then
 * falls back to the static image card).
 */
export async function renderIdCardVideo(d: IdCardImageData, themeId?: string): Promise<{ buffer: Buffer; ext: string } | null> {
  const theme = CARD_THEMES.find((x) => x.id === themeId) ?? CARD_THEMES[0];
  const width = 640;
  const height = 940;
  const dir = await mkdtemp(join(tmpdir(), 'idcard-')).catch(() => null);
  if (!dir) return null;
  let context: BrowserContext | null = null;
  let webmPath: string | undefined;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir, size: { width, height } } });
    const page = await context.newPage();
    await page.setContent(buildCardHtml(d, theme, { animated: true, premium: true }), { waitUntil: 'load', timeout: 20_000 });
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => undefined);
    await page.waitForTimeout(3200); // capture ~3s of the loop
    const video = page.video();
    await page.close();
    await context.close();
    context = null;
    webmPath = video ? await video.path().catch(() => undefined) : undefined;
  } catch (err) {
    vlog.warn({ err }, 'card video record failed');
    await context?.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  if (!webmPath) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  // Prefer H.264 mp4 (crisp, small, autoplays as a loop); fall back to gif if
  // this ffmpeg build lacks libx264.
  const mp4 = join(dir, 'card.mp4');
  if (await runFfmpeg(['-y', '-i', webmPath, '-an', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', mp4])) {
    const buffer = await readFile(mp4).catch(() => null);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return buffer ? { buffer, ext: 'mp4' } : null;
  }
  const gif = join(dir, 'card.gif');
  if (await runFfmpeg(['-y', '-i', webmPath, '-vf', 'fps=15,scale=480:-1:flags=lanczos', '-loop', '0', gif])) {
    const buffer = await readFile(gif).catch(() => null);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return buffer ? { buffer, ext: 'gif' } : null;
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return null;
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('error', () => resolve(false));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
