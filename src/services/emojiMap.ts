import type { Telegram } from 'telegraf';
import { getGlobal, setGlobal } from './global.service';
import { createLogger } from '../core/logger';

const log = createLogger('emojiMap');
const KEY = 'emojiMap';

// A bot-wide map of normal-emoji glyph → premium custom_emoji_id. Every outgoing
// message/caption has these glyphs upgraded to the premium emoji. Cached in
// memory (refreshed periodically) so the hot send path makes no DB read.
let MAP: Record<string, string> = {};

export function getEmojiMap(): Record<string, string> {
  return MAP;
}

export async function refreshEmojiMap(): Promise<void> {
  try {
    const raw = await getGlobal(KEY);
    MAP = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    /* keep the current map on any read/parse error */
  }
}

export async function setEmojiMap(map: Record<string, string>): Promise<void> {
  MAP = map;
  await setGlobal(KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

const TEXT_METHODS = new Set(['sendMessage', 'editMessageText']);
const CAPTION_METHODS = new Set([
  'sendPhoto',
  'sendAnimation',
  'sendVideo',
  'sendAudio',
  'sendDocument',
  'sendVoice',
  'editMessageCaption',
]);

type Payload = Record<string, unknown> & {
  text?: string;
  caption?: string;
  parse_mode?: string;
  entities?: unknown[];
  caption_entities?: unknown[];
};

type Ent = { type: string; offset: number; length: number; url?: string; custom_emoji_id?: string };

const TAG_TYPE: Record<string, string> = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline',
  s: 'strikethrough', strike: 'strikethrough', del: 'strikethrough',
  code: 'code', pre: 'pre', 'tg-emoji': 'custom_emoji', a: 'text_link',
};

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Convert our HTML styling tags (<b>/<i>/<u>/<s>/<code>/<pre>/<a>/<tg-emoji>) into
 * Telegram message entities, returning clean text (tags removed, HTML unescaped)
 * + entities with UTF-16 offsets. This is bullet-proof: no parse_mode is needed,
 * so a message can NEVER render a literal "<b>". Returns null if there's nothing
 * to convert.
 */
function htmlToEntities(input: string): { text: string; entities: Ent[] } | null {
  if (!/<\/?[a-z]/i.test(input)) return null;
  const tagRe = /<(\/)?([a-z0-9-]+)([^>]*)>/gi;
  let out = '';
  let last = 0;
  const stack: Ent[] = [];
  const entities: Ent[] = [];
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = tagRe.exec(input))) {
    const type = TAG_TYPE[m[2].toLowerCase()];
    if (!type) continue; // unknown tag: leave it in the text as-is
    matched = true;
    out += unescapeHtml(input.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[1]) {
      // closing tag → pop the nearest matching open
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].type === type) {
          const open = stack.splice(i, 1)[0];
          const length = out.length - open.offset;
          if (length > 0) entities.push({ ...open, length });
          break;
        }
      }
    } else {
      const e: Ent = { type, offset: out.length, length: 0 };
      const attrs = m[3] || '';
      if (type === 'text_link') e.url = /href="([^"]*)"/i.exec(attrs)?.[1];
      if (type === 'custom_emoji') e.custom_emoji_id = /emoji-id="(\d+)"/i.exec(attrs)?.[1];
      stack.push(e);
    }
  }
  if (!matched) return null;
  out += unescapeHtml(input.slice(last));
  return { text: out, entities: entities.filter((e) => e.type !== 'text_link' || e.url) };
}

// Turn our <b>… styling into entities in place (no parse_mode). Runs before the
// premium-emoji transform, which then adds custom_emoji entities on the clean text.
function applyStyleEntities(method: string, payload: Payload): boolean {
  const field = TEXT_METHODS.has(method) ? 'text' : CAPTION_METHODS.has(method) ? 'caption' : null;
  if (!field) return false;
  const text = payload[field];
  if (typeof text !== 'string' || !text) return false;
  if (payload.parse_mode) return false; // caller opted into HTML/Markdown — leave it
  const conv = htmlToEntities(text);
  if (!conv || !conv.entities.length) {
    // Tags present but nothing convertible (or none) — if it was all tags with no
    // real entities, still drop stray tags so no literal "<b>" shows.
    if (conv) payload[field] = conv.text;
    return !!conv;
  }
  payload[field] = conv.text;
  const entField = field === 'text' ? 'entities' : 'caption_entities';
  const existing = Array.isArray(payload[entField]) ? (payload[entField] as unknown[]) : [];
  payload[entField] = [...existing, ...conv.entities];
  return true;
}

// Mutate the payload to upgrade mapped glyphs to premium emoji. Returns true if
// it changed anything (so the caller can restore + retry on send failure).
function transform(method: string, payload: Payload): boolean {
  const map = MAP;
  const keys = Object.keys(map);
  if (!keys.length) return false;
  const field = TEXT_METHODS.has(method) ? 'text' : CAPTION_METHODS.has(method) ? 'caption' : null;
  if (!field) return false;
  const text = payload[field];
  if (typeof text !== 'string' || !text) return false;
  const present = keys.filter((g) => text.includes(g));
  if (!present.length) return false;

  const pm = typeof payload.parse_mode === 'string' ? payload.parse_mode.toLowerCase() : '';
  if (pm) {
    // Only HTML can carry <tg-emoji>; leave Markdown untouched (too risky).
    if (pm !== 'html') return false;
    let out = text;
    for (const g of present) out = out.split(g).join(`<tg-emoji emoji-id="${map[g]}">${g}</tg-emoji>`);
    payload[field] = out;
    return true;
  }

  // No parse_mode → attach custom_emoji entities at each glyph occurrence.
  const entField = field === 'text' ? 'entities' : 'caption_entities';
  const existing = Array.isArray(payload[entField]) ? (payload[entField] as unknown[]).slice() : [];
  const added: unknown[] = [];
  for (const g of present) {
    let idx = text.indexOf(g);
    while (idx !== -1) {
      added.push({ type: 'custom_emoji', offset: idx, length: g.length, custom_emoji_id: map[g] });
      idx = text.indexOf(g, idx + g.length);
    }
  }
  if (!added.length) return false;
  payload[entField] = [...existing, ...added];
  return true;
}

// Wrap telegram.callApi — the single chokepoint all Bot API calls pass through —
// so premium substitution applies everywhere, and NEVER breaks a message: if the
// upgraded send fails, we restore the original payload and send it as-is.
export function installEmojiSubstitution(telegram: Telegram): void {
  const original = telegram.callApi.bind(telegram);
  const wrapped = async (method: string, payload: Payload, ...rest: unknown[]): Promise<unknown> => {
    if (!payload || (!TEXT_METHODS.has(method) && !CAPTION_METHODS.has(method))) {
      return original(method as never, payload as never, ...(rest as []));
    }
    const snapshot = {
      text: payload.text,
      caption: payload.caption,
      entities: payload.entities,
      caption_entities: payload.caption_entities,
      parse_mode: payload.parse_mode,
    };
    let changed = false;
    try {
      const styled = applyStyleEntities(method, payload);
      changed = transform(method, payload) || styled;
    } catch {
      changed = false;
    }
    try {
      return await original(method as never, payload as never, ...(rest as []));
    } catch (err) {
      if (!changed) throw err;
      Object.assign(payload, snapshot); // undo the upgrade, send the original
      log.debug({ err, method }, 'emoji substitution rejected; sent original');
      return original(method as never, payload as never, ...(rest as []));
    }
  };
  (telegram as unknown as { callApi: typeof wrapped }).callApi = wrapped;

  // Propagate map changes (and cross-instance updates) without a restart.
  setInterval(() => void refreshEmojiMap(), 60_000).unref();
}
