import { readFileSync } from 'node:fs';
import { getBrowser } from './pdf/browser';
import { createLogger } from '../core/logger';

const log = createLogger('namedesign');

/** Bundled Amiri (Arabic) embedded as a data: URI so Chromium always finds it. */
let amiriUri: string | null = null;
function amiriFont(): string {
  if (amiriUri !== null) return amiriUri;
  try {
    const p = require.resolve('@fontsource/amiri/files/amiri-arabic-700-normal.woff2');
    amiriUri = 'data:font/woff2;base64,' + readFileSync(p).toString('base64');
  } catch (err) {
    log.warn({ err }, 'amiri font not found — falling back to system Arabic');
    amiriUri = '';
  }
  return amiriUri;
}

export type NameStyle = 'palestine' | 'gold' | 'fire' | 'royal' | 'ocean';
export const NAME_STYLES: NameStyle[] = ['palestine', 'gold', 'fire', 'royal', 'ocean'];
export const STYLE_LABEL: Record<NameStyle, string> = {
  palestine: '🇵🇸 فلسطيني',
  gold: '✨ ذهبي',
  fire: '🔥 ناري',
  royal: '👑 ملكي',
  ocean: '💧 أزرق',
};

interface StyleDef {
  stops: [string, string, string, string]; // top→bottom gradient
  stroke: string;
  top: string; // emoji above the name
  bottom: string; // emoji below
}
const STYLES: Record<NameStyle, StyleDef> = {
  palestine: { stops: ['#fff6d6', '#f4d477', '#d4af37', '#a9781f'], stroke: '#06301f', top: '👑', bottom: '🇵🇸' },
  gold: { stops: ['#fff8df', '#ffe08a', '#e8b93a', '#9c6f16'], stroke: '#141414', top: '✨', bottom: '✨' },
  fire: { stops: ['#fff1c9', '#ffb347', '#ff5e3a', '#b21f1f'], stroke: '#2a0a06', top: '🔥', bottom: '🔥' },
  royal: { stops: ['#f7e6ff', '#d9a7ff', '#a06bff', '#5b2bb0'], stroke: '#180a2e', top: '👑', bottom: '💜' },
  ocean: { stops: ['#e6fbff', '#8fe3ff', '#33b6ff', '#0b63fb'], stroke: '#04223f', top: '❄️', bottom: '💧' },
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wrap a name into 1–3 balanced lines by words. */
function wrapName(s: string): string[] {
  const words = s.split(' ').filter(Boolean);
  if (words.length <= 1) return [s];
  const total = [...s].length;
  const lines = total <= 10 ? 1 : total <= 22 ? 2 : 3;
  if (lines === 1) return [s];
  const target = Math.ceil(total / lines);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && [...cur].length + 1 + [...w].length > target && out.length < lines - 1) {
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Render a decorated name as a 512×512 transparent PNG — gold/colored gradient
 * text with a contrasting outline, framed by style emoji. Returns null on failure.
 */
export async function renderNameImage(name: string, style: NameStyle = 'palestine'): Promise<Buffer | null> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) return null;
  const st = STYLES[style] ?? STYLES.palestine;
  const lines = wrapName(clean);
  const maxChars = Math.max(...lines.map((l) => [...l].length), 1);
  const fontSize = Math.max(38, Math.min(94, Math.round(432 / (maxChars * 0.62))));
  const lh = Math.round(fontSize * 1.3);
  const svgH = lines.length * lh + 24;
  const texts = lines
    .map((l, i) => `<text x="256" y="${Math.round(fontSize * 0.95) + i * lh}">${esc(l)}</text>`)
    .join('');
  const font = amiriFont();
  const face = font ? `@font-face{font-family:Amiri;src:url('${font}') format('woff2');font-weight:700}` : '';
  const stops = st.stops;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${face}
html,body{margin:0}
.wrap{width:512px;height:512px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:transparent}
.emj{line-height:1;filter:drop-shadow(0 4px 9px rgba(0,0,0,.5))}
.top{font-size:82px;margin-bottom:2px}
.bot{font-size:48px;margin-top:2px}
svg{filter:drop-shadow(0 5px 8px rgba(0,0,0,.5))}
.rule{width:220px;height:4px;margin:14px 0 10px;border-radius:4px;background:linear-gradient(90deg,transparent,${stops[2]},transparent);filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
text{font-family:Amiri,'Noto Naskh Arabic',serif;font-weight:700;font-size:${fontSize}px;text-anchor:middle;direction:rtl;
  fill:url(#g);stroke:${st.stroke};stroke-width:6px;paint-order:stroke;stroke-linejoin:round}
</style></head><body><div class="wrap">
  <div class="emj top">${st.top}</div>
  <svg width="512" height="${svgH}" viewBox="0 0 512 ${svgH}"><defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${stops[0]}"/><stop offset="0.45" stop-color="${stops[1]}"/>
      <stop offset="0.72" stop-color="${stops[2]}"/><stop offset="1" stop-color="${stops[3]}"/>
    </linearGradient></defs>${texts}</svg>
  <div class="rule"></div>
  <div class="emj bot">${st.bottom}</div>
</div></body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 2 });
  try {
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 20_000 });
    await page.waitForTimeout(180); // let the embedded font apply before capture
    const buf = await page.screenshot({ type: 'png', omitBackground: true });
    return Buffer.from(buf);
  } catch (err) {
    log.warn({ err }, 'name render failed');
    return null;
  } finally {
    await page.close().catch(() => undefined);
  }
}
