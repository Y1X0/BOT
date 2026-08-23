import { getGlobal, setGlobal } from './global.service';
import { createLogger } from '../core/logger';

/**
 * Bot-wide "message overrides": the owner can replace the text of any static bot
 * message. Keyed by the NORMALIZED original text (HTML tags stripped, whitespace
 * collapsed) so it matches the message wherever the bot would send it. Stored as
 * one JSON blob in GlobalConfig and cached in memory for the hot send path.
 */
const KEY = 'msgOverrides';

export interface Override {
  orig: string; // the original text (for listing)
  text: string; // the replacement text
  entities: unknown[]; // Telegram message entities for the replacement
}

// normalizedOriginal → Override
let OVERRIDES = new Map<string, Override>();

/** Strip HTML styling tags and collapse whitespace, so the same logical message
 *  matches whether the caller passed tags, entities, or plain text. */
export function normalizeKey(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fast lookup used by the outgoing interceptor. Undefined when nothing matches
 *  (and instant when no overrides are configured). */
export function getOverride(text: string): Override | undefined {
  if (!OVERRIDES.size) return undefined;
  return OVERRIDES.get(normalizeKey(text));
}

export function overrideCount(): number {
  return OVERRIDES.size;
}

export function listOverrides(): { key: string; orig: string; text: string }[] {
  return [...OVERRIDES.entries()].map(([key, v]) => ({ key, orig: v.orig, text: v.text }));
}

function serialize(): string | null {
  if (!OVERRIDES.size) return null;
  const obj: Record<string, Override> = {};
  for (const [k, v] of OVERRIDES) obj[k] = v;
  return JSON.stringify(obj);
}

/** Reload the cache from storage (called at startup and periodically). */
export async function refreshOverrides(): Promise<void> {
  try {
    const raw = await getGlobal(KEY);
    if (!raw) {
      OVERRIDES = new Map();
      return;
    }
    const obj = JSON.parse(raw) as Record<string, Override>;
    const next = new Map<string, Override>();
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.text === 'string') {
        next.set(k, { orig: v.orig ?? k, text: v.text, entities: Array.isArray(v.entities) ? v.entities : [] });
      }
    }
    OVERRIDES = next;
  } catch (err) {
    createLogger('msg-overrides').warn({ err }, 'refresh failed; keeping current');
  }
}

/** Add or replace an override for `original`. Persists and updates the cache. */
export async function setOverride(original: string, text: string, entities: unknown[]): Promise<void> {
  const key = normalizeKey(original);
  if (!key) return;
  OVERRIDES.set(key, { orig: original.trim().slice(0, 400), text, entities: entities ?? [] });
  await setGlobal(KEY, serialize());
}

/** Remove one override by its normalized key. Returns true if it existed. */
export async function removeOverride(key: string): Promise<boolean> {
  const existed = OVERRIDES.delete(key);
  if (existed) await setGlobal(KEY, serialize());
  return existed;
}

/** Remove every override. */
export async function clearOverrides(): Promise<void> {
  OVERRIDES = new Map();
  await setGlobal(KEY, null);
}
