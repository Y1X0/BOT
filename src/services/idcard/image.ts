import { getBrowser } from '../pdf/browser';
import { fontFaceCss } from '../pdf/fonts';

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

/** A row of the stats grid. */
function stat(icon: string, label: string, value: string): string {
  return `<div class="stat"><div class="ico">${icon}</div><div class="col"><div class="lab">${esc(label)}</div><div class="val">${esc(value)}</div></div></div>`;
}

function buildCardHtml(d: IdCardImageData): string {
  const avatar = d.avatarDataUri
    ? `<img class="ava" src="${d.avatarDataUri}" alt="">`
    : `<div class="ava ava-ph">${esc(d.initial)}</div>`;
  const bg = d.avatarDataUri ? `background-image:url('${d.avatarDataUri}');` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaceCss()}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{background:transparent;}
.card{width:640px;position:relative;overflow:hidden;border-radius:34px;
  font-family:'Cairo','Amiri',sans-serif;color:#fff;direction:rtl;
  border:2px solid rgba(232,200,106,.55);box-shadow:0 24px 70px rgba(0,0,0,.6);}
.bgimg{position:absolute;inset:0;${bg}background-size:cover;background-position:center;filter:blur(26px) brightness(.42) saturate(1.2);transform:scale(1.25);}
.tint{position:absolute;inset:0;background:linear-gradient(160deg,rgba(20,14,40,.86),rgba(8,8,16,.94));}
.frame{position:relative;padding:36px 34px 30px;}
.crown{text-align:center;font-size:30px;letter-spacing:8px;color:#e8c86a;text-shadow:0 0 18px rgba(232,200,106,.6);}
.head{display:flex;flex-direction:column;align-items:center;margin-top:6px;}
.ava{width:150px;height:150px;border-radius:50%;object-fit:cover;border:4px solid #e8c86a;
  box-shadow:0 0 0 6px rgba(232,200,106,.16),0 10px 30px rgba(0,0,0,.55);background:#222;}
.ava-ph{display:flex;align-items:center;justify-content:center;font-size:64px;font-weight:700;color:#e8c86a;background:linear-gradient(145deg,#2a2350,#15131f);}
.name{font-size:34px;font-weight:700;margin-top:16px;text-align:center;line-height:1.25;
  background:linear-gradient(90deg,#fff7e0,#e8c86a,#fff7e0);-webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:0 2px 14px rgba(232,200,106,.25);max-width:100%;}
.uname{font-size:17px;color:#b9c0d4;margin-top:4px;direction:ltr;}
.rankpill{margin:14px auto 2px;display:inline-block;padding:7px 20px;border-radius:999px;font-size:18px;font-weight:700;
  color:#1a1428;background:linear-gradient(90deg,#e8c86a,#f6e3a6);box-shadow:0 6px 18px rgba(232,200,106,.32);}
.rankwrap{text-align:center;}
.divider{height:1px;margin:20px 2px 16px;background:linear-gradient(90deg,transparent,rgba(232,200,106,.55),transparent);}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;}
.stat{display:flex;align-items:center;gap:11px;background:rgba(255,255,255,.055);border:1px solid rgba(232,200,106,.16);
  border-radius:16px;padding:11px 13px;}
.stat .ico{font-size:23px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));}
.stat .col{min-width:0;flex:1;}
.stat .lab{font-size:12.5px;color:#aab0c6;}
.stat .val{font-size:16.5px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.full{grid-column:1 / -1;}
.idbar{grid-column:1 / -1;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:9px;
  background:rgba(232,200,106,.1);border:1px solid rgba(232,200,106,.3);border-radius:14px;padding:10px;}
.idbar .k{font-size:14px;color:#e8c86a;}
.idbar .v{font-size:18px;font-weight:700;letter-spacing:1px;direction:ltr;}
.foot{text-align:center;margin-top:18px;font-size:15px;letter-spacing:6px;color:rgba(232,200,106,.85);}
</style></head><body>
<div class="card"><div class="bgimg"></div><div class="tint"></div>
  <div class="frame">
    <div class="crown">👑 ✦ 👑</div>
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
    <div class="foot">V I P</div>
  </div>
</div>
</body></html>`;
}

/** Render the profile card to a crisp PNG buffer. Throws if Chromium is unavailable. */
export async function renderIdCardImage(d: IdCardImageData): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 680, height: 1000 }, deviceScaleFactor: 2 });
  try {
    // 'load' (not 'networkidle') so an embedded-only page never stalls waiting
    // for network quiet; then explicitly wait for the embedded fonts to shape.
    await page.setContent(buildCardHtml(d), { waitUntil: 'load', timeout: 20_000 });
    // Wait for embedded fonts to finish shaping (string form avoids DOM types).
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => undefined);
    const el = await page.$('.card');
    const shot = await (el ?? page).screenshot({ type: 'png', omitBackground: true });
    return Buffer.from(shot);
  } finally {
    await page.close().catch(() => undefined);
  }
}
