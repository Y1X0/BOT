import { prisma } from '../core/database';
import type { Role } from '../utils/permissions';

/** Custom bot ranks assignable via commands (never 'owner'/'member' — those are inherent). */
export const ASSIGNABLE_ROLES = ['admin', 'moderator', 'vip'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** The bot-internal rank a user holds in a chat, or null if none assigned. */
export async function getChatRole(chatId: number | bigint, userId: number | bigint): Promise<Role | null> {
  const row = await prisma.chatRole
    .findUnique({ where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } } })
    .catch(() => null);
  return (row?.role as Role) ?? null;
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
