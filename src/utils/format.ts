import type { BotContext } from '../core/context';
import { Html } from '../locales';

/** Escape text for Telegram MarkdownV2. */
export function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Make a decorated Telegram name readable: NFKD folds fancy math/bold/fraktur
 * letters back to plain ones, \p{M} drops stacked harakat/zalgo combining marks,
 * and the last range strips zero-width & bidi controls. Falls back to the raw
 * string if nothing legible survives.
 */
export function cleanName(s?: string): string {
  const raw = String(s ?? '');
  const t = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .trim();
  return t || raw;
}

/** A friendly display name for a Telegram user (never throws). */
export function displayName(user?: {
  first_name?: string;
  username?: string;
  id?: number;
}): string {
  if (!user) return 'Unknown';
  if (user.first_name) return cleanName(user.first_name);
  if (user.username) return `@${user.username}`;
  return `User ${user.id ?? ''}`.trim();
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A clickable mention of a user as an HTML <a> tag. The outgoing interceptor
 * turns it into a text_link entity (tg://user?id=… works even without a
 * username), so bot messages tag people instead of printing a plain name. The
 * name is HTML-escaped; pass the result where HTML/styling is rendered.
 */
export function mention(user?: { first_name?: string; username?: string; id?: number }): Html {
  const name = displayName(user);
  if (!user?.id) return new Html(escHtml(name));
  return new Html(`<a href="tg://user?id=${user.id}">${escHtml(name)}</a>`);
}

/**
 * The identity that sent a message. When a user posts "as a channel" in a
 * group, Telegram omits `from` and provides `sender_chat` instead — this
 * treats that channel as its own account (using its unique id), so features
 * keyed by a sender still work. Returns null only when neither is present.
 */
export function senderIdentity(ctx: BotContext): { id: number; name: string } | null {
  const sc = ctx.senderChat as { id: number; title?: string; username?: string } | undefined;
  if (sc) return { id: sc.id, name: sc.title ?? (sc.username ? `@${sc.username}` : 'قناة') };
  if (ctx.from) return { id: ctx.from.id, name: displayName(ctx.from) };
  return null;
}

/**
 * Resolve the target user of a moderation command:
 * the replied-to user, or a mentioned/id argument.
 */
export function resolveTarget(ctx: BotContext):
  | { id: number; first_name?: string; username?: string }
  | null {
  const msg = ctx.message as { reply_to_message?: { from?: { id: number; first_name?: string; username?: string } } } | undefined;
  const replied = msg?.reply_to_message?.from;
  if (replied) return replied;
  return null;
}

/** Pick a random element from a non-empty array. */
export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
