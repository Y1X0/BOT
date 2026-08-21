import type { BotContext } from '../core/context';
import { env } from '../config/env';
import { getChatRole } from '../services/roles.service';

/** Role hierarchy, ordered from most to least privileged.
 *  owner 👑 > supervisor 🛡 > manager 🔰 > admin ⭐ > vip 💎 > member 👤 */
export const ROLES = ['owner', 'supervisor', 'manager', 'admin', 'vip', 'member'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  owner: 6,
  supervisor: 5,
  manager: 4,
  admin: 3,
  vip: 2,
  member: 0,
};

/** Rank number for a role — exported for target-vs-actor comparisons. */
export function rankOf(role: Role): number {
  return RANK[role];
}

/** Can `actor` act on / punish / outrank `target`? Only when strictly higher —
 *  nobody can act on someone of equal or greater rank. */
export function canActOn(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

/** Returns true if `role` is at least as privileged as `required`. */
export function hasRole(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

/** Is this user a global bot owner (from OWNER_IDS env)? */
export function isBotOwner(userId: number | bigint): boolean {
  return env.OWNER_IDS.some((id) => id === BigInt(userId));
}

/**
 * Short-lived cache of a resolved (chat,user) role. Without it, EVERY incoming
 * message paid for a Telegram getChatMember round-trip (~200-500ms from a cloud
 * host) plus a DB read in the context middleware — the single biggest source of
 * per-message lag. Admin status and bot ranks change rarely, so a minute of
 * staleness is harmless; role-changing actions clear the entry explicitly.
 */
interface RoleEntry {
  role: Role;
  at: number;
}
const roleCache = new Map<string, RoleEntry>();
const ROLE_TTL_MS = 60_000;
const ROLE_MAX = 5000;
const roleKey = (chatId: number | bigint, userId: number | bigint): string => `${chatId}:${userId}`;

/** Drop a cached role (call after granting/revoking a rank or admin change). */
export function invalidateRole(chatId: number | bigint, userId: number | bigint): void {
  roleCache.delete(roleKey(chatId, userId));
}

/**
 * Resolve the sender's role in the current chat.
 * Combines Telegram's native admin status with our own moderator assignments
 * and the global owner list. Cached per (chat,user) for a short TTL.
 */
export async function resolveRole(ctx: BotContext): Promise<Role> {
  const userId = ctx.from?.id;
  const chat = ctx.chat;
  if (!userId || !chat) return 'member';

  if (isBotOwner(userId)) return 'owner';

  if (chat.type === 'private') return 'member';

  // Anonymous admins post AS the group itself (sender_chat === this chat) — only
  // admins can do that, and getChatMember on the GroupAnonymousBot would wrongly
  // read as 'member'. Treat them as manager-level so they can still moderate.
  const senderChat = ctx.senderChat;
  if (senderChat && senderChat.id === chat.id) return 'manager';

  const key = roleKey(chat.id, userId);
  const cached = roleCache.get(key);
  if (cached && Date.now() - cached.at < ROLE_TTL_MS) return cached.role;

  let tgRole: Role = 'member';
  let isCreator = false;
  try {
    const member = await ctx.telegram.getChatMember(chat.id, userId);
    if (member.status === 'creator') isCreator = true;
    // A real Telegram admin is trusted with manager-level bot powers (settings
    // + assigning the lighter bot ranks). supervisor/owner sit above them.
    else if (member.status === 'administrator') tgRole = 'manager';
  } catch {
    // getChatMember can fail transiently; fall through to member.
  }

  // A rank assigned through the bot grants powers even if the user isn't a
  // Telegram admin. Take whichever is higher: their Telegram status or the
  // custom bot rank stored for this chat.
  let role: Role = tgRole;
  if (isCreator) {
    role = 'owner';
  } else {
    const custom = await getChatRole(chat.id, userId).catch(() => null);
    if (custom && RANK[custom] > RANK[tgRole]) role = custom;
  }

  roleCache.set(key, { role, at: Date.now() });
  if (roleCache.size > ROLE_MAX) {
    const oldest = roleCache.keys().next().value;
    if (oldest) roleCache.delete(oldest);
  }
  return role;
}

/**
 * Resolve the role of an ARBITRARY user in the current chat (e.g. the target of
 * a mute/promote). Like resolveRole but for someone other than the sender, and
 * uncached (used only on infrequent staff actions).
 */
export async function resolveUserRole(ctx: BotContext, userId: number | bigint): Promise<Role> {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') return 'member';
  if (isBotOwner(userId)) return 'owner';

  let tgRole: Role = 'member';
  try {
    const member = await ctx.telegram.getChatMember(chat.id, Number(userId));
    if (member.status === 'creator') return 'owner';
    if (member.status === 'administrator') tgRole = 'manager';
  } catch {
    /* transient — fall through */
  }
  const custom = await getChatRole(chat.id, userId).catch(() => null);
  return custom && RANK[custom] > RANK[tgRole] ? custom : tgRole;
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
