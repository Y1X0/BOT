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

// A chat's linked-channel id changes rarely — cache it so recognizing someone
// who posts "as the linked channel" costs at most one getChat per 10 minutes.
const linkedChatCache = new Map<number, { id: number | null; at: number }>();
const LINKED_TTL_MS = 600_000;

async function getLinkedChatId(ctx: BotContext, chatId: number): Promise<number | null> {
  const cached = linkedChatCache.get(chatId);
  if (cached && Date.now() - cached.at < LINKED_TTL_MS) return cached.id;
  let id: number | null = null;
  try {
    const chat = await ctx.telegram.getChat(chatId);
    id = (chat as { linked_chat_id?: number }).linked_chat_id ?? null;
  } catch {
    /* transient — leave null */
  }
  linkedChatCache.set(chatId, { id, at: Date.now() });
  return id;
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

  // Someone can post hidden, "as a channel". Two of those are admin-only and we
  // trust them as manager-level so they can still moderate:
  //   • as the group itself (anonymous admin): sender_chat === this chat.
  //   • as the group's LINKED channel: sender_chat === linked_chat_id.
  // Any OTHER channel hides the real user entirely (Telegram gives no user id),
  // so it cannot be verified and stays a member.
  const senderChat = ctx.senderChat;
  if (senderChat) {
    if (senderChat.id === chat.id) return 'supervisor';
    const linkedId = await getLinkedChatId(ctx, chat.id);
    if (linkedId && senderChat.id === linkedId) return 'supervisor';
  }

  const key = roleKey(chat.id, userId);
  const cached = roleCache.get(key);
  if (cached && Date.now() - cached.at < ROLE_TTL_MS) return cached.role;

  let tgRole: Role = 'member';
  let isCreator = false;
  let resolved = false;
  try {
    const member = await ctx.telegram.getChatMember(chat.id, userId);
    resolved = true;
    if (member.status === 'creator') isCreator = true;
    // A real Telegram admin is trusted with supervisor-level bot powers: they can
    // moderate everyone below them and promote managers/admins/vips. Only the
    // group's creator (owner) sits above them.
    else if (member.status === 'administrator') tgRole = 'supervisor';
  } catch {
    // getChatMember can fail right after the bot is added to a group. The admin
    // list is a more reliable source (one call covers everyone), so fall back to
    // it before giving up — otherwise a real admin is wrongly seen as a member.
    try {
      const admins = await ctx.telegram.getChatAdministrators(chat.id);
      const me = admins.find((a) => a.user?.id === Number(userId));
      resolved = true;
      if (me?.status === 'creator') isCreator = true;
      else if (me) tgRole = 'manager';
    } catch {
      // Still unknown — treat as member for THIS message but don't cache it, so
      // the next message retries instead of being stuck denied for the full TTL.
    }
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

  // Only cache a confirmed lookup — never a failed one (that would pin an admin
  // to "member" for the whole TTL).
  if (resolved) {
    roleCache.set(key, { role, at: Date.now() });
    if (roleCache.size > ROLE_MAX) {
      const oldest = roleCache.keys().next().value;
      if (oldest) roleCache.delete(oldest);
    }
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
    if (member.status === 'administrator') tgRole = 'supervisor';
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
