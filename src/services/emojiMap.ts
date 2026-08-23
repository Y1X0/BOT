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

// Auto-enable HTML for messages that carry our <b> styling markup, so a styled
// string renders bold everywhere without every call site opting in. Conservative
// by design: only when there's no parse_mode already, no manual entities to
// conflict with, and the text actually contains a <b>/<i>/<u> tag.
function maybeEnableHtml(method: string, payload: Payload): void {
  const field = TEXT_METHODS.has(method) ? 'text' : CAPTION_METHODS.has(method) ? 'caption' : null;
  if (!field) return;
  const text = payload[field];
  if (typeof text !== 'string' || !text) return;
  if (payload.parse_mode) return;
  if (Array.isArray(payload.entities) && payload.entities.length) return;
  if (Array.isArray(payload.caption_entities) && payload.caption_entities.length) return;
  if (/<\/?(b|i|u|s|code|pre|a|tg-emoji)\b/i.test(text)) payload.parse_mode = 'HTML';
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
      maybeEnableHtml(method, payload);
      changed = transform(method, payload) || payload.parse_mode !== snapshot.parse_mode;
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
