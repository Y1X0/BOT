import type { BotContext } from '../core/context';
import { Html } from '../locales';
import { prisma } from '../core/database';

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

type TargetUser = { id: number; first_name?: string; username?: string };
interface TargetEnt { type: string; offset: number; length: number; user?: TargetUser }
interface TargetMsg {
  text?: string;
  caption?: string;
  reply_to_message?: { from?: TargetUser };
  entities?: TargetEnt[];
  caption_entities?: TargetEnt[];
}

/**
 * Resolve the target of a moderation command WITHOUT any async lookup:
 *   1. the replied-to user,
 *   2. a text_mention (mention-by-name of a user who has no @username — the
 *      entity carries the full user object, so we get the id directly),
 *   3. a raw numeric id argument (e.g. «كتم 123456789»).
 * A bare «@username» needs a lookup — use resolveTargetUser for that.
 */
export function resolveTarget(ctx: BotContext): TargetUser | null {
  const msg = ctx.message as TargetMsg | undefined;
  if (!msg) return null;
  const replied = msg.reply_to_message?.from;
  if (replied) return replied;
  const ents = msg.entities || msg.caption_entities || [];
  for (const e of ents) {
    if (e.type === 'text_mention' && e.user?.id) return e.user;
  }
  const text = msg.text || msg.caption || '';
  const m = text.match(/(?:^|\s)(\d{5,20})(?:\s|$)/);
  if (m) return { id: Number(m[1]) };
  return null;
}

/** Extract a bare @username target (from a `mention` entity or the raw text). */
function usernameTarget(msg: TargetMsg): string | null {
  const text = msg.text || msg.caption || '';
  const ents = msg.entities || msg.caption_entities || [];
  for (const e of ents) {
    if (e.type === 'mention') return text.slice(e.offset + 1, e.offset + e.length);
  }
  const m = text.match(/@([A-Za-z0-9_]{4,32})/);
  return m ? m[1] : null;
}

/**
 * Full target resolution for moderation, including «@username»: falls back to the
 * synchronous forms first, then resolves a username via this chat's Member table
 * (no API call, and we get the display name), and finally via Telegram itself.
 */
export async function resolveTargetUser(ctx: BotContext): Promise<TargetUser | null> {
  const sync = resolveTarget(ctx);
  if (sync) return sync;
  const msg = ctx.message as TargetMsg | undefined;
  if (!msg || !ctx.chat) return null;
  const username = usernameTarget(msg);
  if (!username) return null;
  const member = await prisma.member
    .findFirst({
      where: { chatId: BigInt(ctx.chat.id), username },
      select: { userId: true, firstName: true, username: true },
    })
    .catch(() => null);
  if (member)
    return { id: Number(member.userId), first_name: member.firstName ?? undefined, username: member.username ?? undefined };
  try {
    const chat = (await ctx.telegram.getChat('@' + username)) as {
      id: number;
      type: string;
      first_name?: string;
      username?: string;
    };
    if (chat?.id && chat.type === 'private') return { id: chat.id, first_name: chat.first_name, username: chat.username };
  } catch {
    /* unknown username */
  }
  return null;
}

/** Pick a random element from a non-empty array. */
export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
