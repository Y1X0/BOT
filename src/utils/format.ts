import type { BotContext } from '../core/context';

/** Escape text for Telegram MarkdownV2. */
export function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** A friendly display name for a Telegram user (never throws). */
export function displayName(user?: {
  first_name?: string;
  username?: string;
  id?: number;
}): string {
  if (!user) return 'Unknown';
  if (user.first_name) return user.first_name;
  if (user.username) return `@${user.username}`;
  return `User ${user.id ?? ''}`.trim();
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

/** An @mention-style clickable name for MarkdownV2. */
export function mention(user: { id: number; first_name?: string; username?: string }): string {
  const name = escapeMd(displayName(user));
  return `[${name}](tg://user?id=${user.id})`;
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
