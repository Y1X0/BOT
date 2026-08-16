import type { BotContext } from '../core/context';
import { env } from '../config/env';
import { getChatRole } from '../services/roles.service';

/** Role hierarchy, ordered from most to least privileged. */
export const ROLES = ['owner', 'admin', 'moderator', 'vip', 'member'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  owner: 4,
  admin: 3,
  moderator: 2,
  vip: 1,
  member: 0,
};

/** Returns true if `role` is at least as privileged as `required`. */
export function hasRole(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

/** Is this user a global bot owner (from OWNER_IDS env)? */
export function isBotOwner(userId: number | bigint): boolean {
  return env.OWNER_IDS.some((id) => id === BigInt(userId));
}

/**
 * Resolve the sender's role in the current chat.
 * Combines Telegram's native admin status with our own moderator assignments
 * and the global owner list.
 */
export async function resolveRole(ctx: BotContext): Promise<Role> {
  const userId = ctx.from?.id;
  const chat = ctx.chat;
  if (!userId || !chat) return 'member';

  if (isBotOwner(userId)) return 'owner';

  if (chat.type === 'private') return 'member';

  let tgRole: Role = 'member';
  try {
    const member = await ctx.telegram.getChatMember(chat.id, userId);
    if (member.status === 'creator') return 'owner';
    if (member.status === 'administrator') tgRole = 'admin';
  } catch {
    // getChatMember can fail transiently; fall through to member.
  }

  // A rank assigned through the bot grants powers even if the user isn't a
  // Telegram admin. Take whichever is higher: their Telegram status or the
  // custom bot rank stored for this chat.
  const custom = await getChatRole(chat.id, userId).catch(() => null);
  if (custom && RANK[custom] > RANK[tgRole]) return custom;
  return tgRole;
}

/** Guard: only allow handler to run for users with at least `required` role. */
export function requireRole(required: Role) {
  return async (ctx: BotContext, next: () => Promise<void>): Promise<void> => {
    const role = ctx.state.role ?? (await resolveRole(ctx));
    ctx.state.role = role;
    if (!hasRole(role, required)) {
      const t = ctx.state.t;
      await ctx.reply(t ? t('errors.no_permission') : '⛔️ You do not have permission for this.');
      return;
    }
    await next();
  };
}
