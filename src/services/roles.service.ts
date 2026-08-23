import { prisma } from '../core/database';
import { getGlobal, setGlobal } from './global.service';
import { createLogger } from '../core/logger';
import type { Role } from '../utils/permissions';

const log = createLogger('roles');

/**
 * One-time migration to the unified 6-tier role model. Old stored ranks map:
 *   admin → manager,  moderator → admin,  vip → vip (unchanged).
 * NOT idempotent (admin is also a NEW valid value), so it's guarded by a flag
 * and the two updates run in this order so they never collide.
 */
export async function migrateRolesV2(): Promise<void> {
  if (await getGlobal('rolesMigratedV2')) return;
  try {
    const a = await prisma.chatRole.updateMany({ where: { role: 'admin' }, data: { role: 'manager' } });
    const m = await prisma.chatRole.updateMany({ where: { role: 'moderator' }, data: { role: 'admin' } });
    await setGlobal('rolesMigratedV2', '1');
    log.info({ adminToManager: a.count, moderatorToAdmin: m.count }, 'roles migrated to v2');
  } catch (err) {
    log.error({ err }, 'roles v2 migration failed — will retry next start');
  }
}

/**
 * One-time migration to the founder/owner model (supervisor removed):
 *   supervisor → manager,  then delete any row whose role isn't assignable now.
 * Idempotent enough to retry: converting an already-gone 'supervisor' is a no-op,
 * and the delete only removes junk values.
 */
export async function migrateRolesV3(): Promise<void> {
  if (await getGlobal('rolesMigratedV3')) return;
  try {
    const s = await prisma.chatRole.updateMany({ where: { role: 'supervisor' }, data: { role: 'manager' } });
    const d = await prisma.chatRole.deleteMany({ where: { role: { notIn: [...ASSIGNABLE_ROLES] } } });
    await setGlobal('rolesMigratedV3', '1');
    log.info({ supervisorToManager: s.count, deletedInvalid: d.count }, 'roles migrated to v3');
  } catch (err) {
    log.error({ err }, 'roles v3 migration failed — will retry next start');
  }
}

/** Custom bot ranks assignable via commands (never 'founder'/'member' — those are inherent). */
export const ASSIGNABLE_ROLES = ['owner', 'manager', 'admin', 'vip'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Valid stored role values — a stored rank outside this set is treated as none. */
const VALID_STORED = new Set<string>(ASSIGNABLE_ROLES);

/** The bot-internal rank a user holds in a chat, or null if none assigned.
 *  A stored value outside the current model (e.g. a legacy 'supervisor' not yet
 *  migrated) is treated as null so it never leaks into permission checks. */
export async function getChatRole(chatId: number | bigint, userId: number | bigint): Promise<Role | null> {
  const row = await prisma.chatRole
    .findUnique({ where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } } })
    .catch(() => null);
  if (!row || !VALID_STORED.has(row.role)) return null;
  return row.role as Role;
}

export async function setChatRole(
  chatId: number | bigint,
  userId: number | bigint,
  role: AssignableRole,
  name: string | null,
  assignedBy: number | bigint | null,
): Promise<void> {
  await prisma.chatRole
    .upsert({
      where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
      create: {
        chatId: BigInt(chatId),
        userId: BigInt(userId),
        role,
        name,
        assignedBy: assignedBy != null ? BigInt(assignedBy) : null,
      },
      update: { role, name, assignedBy: assignedBy != null ? BigInt(assignedBy) : null },
    })
    .catch(() => undefined);
}

/** Remove a user's custom rank. Returns true if a rank was actually removed. */
export async function removeChatRole(chatId: number | bigint, userId: number | bigint): Promise<boolean> {
  const res = await prisma.chatRole
    .deleteMany({ where: { chatId: BigInt(chatId), userId: BigInt(userId) } })
    .catch(() => ({ count: 0 }));
  return res.count > 0;
}

/** All custom-rank holders in a chat (for the /roles list). */
export async function listChatRoles(
  chatId: number | bigint,
): Promise<{ userId: string; role: string; name: string | null }[]> {
  const rows = await prisma.chatRole
    .findMany({ where: { chatId: BigInt(chatId) }, orderBy: { createdAt: 'asc' } })
    .catch(() => []);
  return rows.map((r) => ({ userId: r.userId.toString(), role: r.role, name: r.name }));
}
