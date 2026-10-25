import { prisma } from '../../core/database';
import { canApprove, canGenerate, canRevoke, consentHash, type ConsentStatus } from './policy';

/**
 * Database-backed consent records for voice cloning. Stores only references
 * (Telegram file_ids) and a hash of the consent text — never the raw audio and
 * never the full declaration — so no recordings or sensitive consent text leak
 * into rows, git, or logs.
 */

export interface NewConsent {
  requesterId: bigint;
  chatId?: bigint | null;
  voiceOwner: string;
  scope: string;
  revocable: boolean;
  declaration: string; // full consent text (hashed, not stored verbatim)
  refFileIds: string[];
  refSeconds: number;
}

export type ConsentRow = {
  id: number;
  requesterId: bigint;
  chatId: bigint | null;
  voiceOwner: string;
  scope: string;
  revocable: boolean;
  status: string;
  consentSha: string;
  refFileIds: string;
  refCount: number;
  refSeconds: number;
  reviewedBy: bigint | null;
  reviewedAt: Date | null;
  note: string | null;
  genCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Parse the stored JSON array of reference file_ids. */
export function refIds(row: Pick<ConsentRow, 'refFileIds'>): string[] {
  try {
    const v = JSON.parse(row.refFileIds);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Create a new PENDING consent request. Returns the row id. */
export async function createPending(input: NewConsent): Promise<number> {
  const sha = consentHash({
    requesterId: input.requesterId,
    voiceOwner: input.voiceOwner,
    scope: input.scope,
    declaration: input.declaration,
  });
  const row = await prisma.voiceConsent.create({
    data: {
      requesterId: input.requesterId,
      chatId: input.chatId ?? null,
      voiceOwner: input.voiceOwner.slice(0, 120),
      scope: input.scope.slice(0, 300),
      revocable: input.revocable,
      status: 'pending',
      consentSha: sha,
      refFileIds: JSON.stringify(input.refFileIds.slice(0, 10)),
      refCount: input.refFileIds.length,
      refSeconds: input.refSeconds,
    },
    select: { id: true },
  });
  return row.id;
}

export async function getConsent(id: number): Promise<ConsentRow | null> {
  return (await prisma.voiceConsent.findUnique({ where: { id } })) as ConsentRow | null;
}

/** Owner approval. Enforces the owner gate; returns a typed outcome. */
export async function approveConsent(
  id: number,
  approverId: bigint,
): Promise<{ ok: true; row: ConsentRow } | { ok: false; error: 'notowner' | 'notfound' | 'notpending' }> {
  if (!canApprove(approverId)) return { ok: false, error: 'notowner' };
  const row = await getConsent(id);
  if (!row) return { ok: false, error: 'notfound' };
  if (row.status !== 'pending') return { ok: false, error: 'notpending' };
  const updated = (await prisma.voiceConsent.update({
    where: { id },
    data: { status: 'approved', reviewedBy: approverId, reviewedAt: new Date() },
  })) as ConsentRow;
  return { ok: true, row: updated };
}

/** Owner rejection. */
export async function rejectConsent(
  id: number,
  approverId: bigint,
  note?: string,
): Promise<{ ok: true; row: ConsentRow } | { ok: false; error: 'notowner' | 'notfound' | 'notpending' }> {
  if (!canApprove(approverId)) return { ok: false, error: 'notowner' };
  const row = await getConsent(id);
  if (!row) return { ok: false, error: 'notfound' };
  if (row.status !== 'pending') return { ok: false, error: 'notpending' };
  const updated = (await prisma.voiceConsent.update({
    where: { id },
    data: { status: 'rejected', reviewedBy: approverId, reviewedAt: new Date(), note: note?.slice(0, 300) ?? null },
  })) as ConsentRow;
  return { ok: true, row: updated };
}

/** Revoke an approved (or pending) consent. Requester-or-owner, honoring revocable. */
export async function revokeConsent(
  id: number,
  userId: bigint,
  note?: string,
): Promise<{ ok: true; row: ConsentRow } | { ok: false; error: 'notallowed' | 'notfound' | 'alreadygone' }> {
  const row = await getConsent(id);
  if (!row) return { ok: false, error: 'notfound' };
  if (row.status === 'revoked' || row.status === 'rejected') return { ok: false, error: 'alreadygone' };
  if (!canRevoke({ requesterId: row.requesterId, revocable: row.revocable }, userId)) {
    return { ok: false, error: 'notallowed' };
  }
  const updated = (await prisma.voiceConsent.update({
    where: { id },
    data: { status: 'revoked', note: note?.slice(0, 300) ?? row.note },
  })) as ConsentRow;
  return { ok: true, row: updated };
}

/** Gate a generation attempt against the (fresh) record. */
export async function authorizeGeneration(
  id: number,
  userId: bigint,
): Promise<{ ok: true; row: ConsentRow } | { ok: false; reason: string }> {
  const row = await getConsent(id);
  if (!row) return { ok: false, reason: 'notfound' };
  const verdict = canGenerate({ status: row.status, requesterId: row.requesterId }, userId);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, row };
}

export async function bumpGenCount(id: number): Promise<void> {
  await prisma.voiceConsent.update({ where: { id }, data: { genCount: { increment: 1 } } }).catch(() => undefined);
}

/** A user's own requests, newest first. */
export async function listForUser(requesterId: bigint, limit = 10): Promise<ConsentRow[]> {
  return (await prisma.voiceConsent.findMany({
    where: { requesterId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })) as ConsentRow[];
}

/** Pending requests awaiting owner review, oldest first. */
export async function listPending(limit = 20): Promise<ConsentRow[]> {
  return (await prisma.voiceConsent.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })) as ConsentRow[];
}

export const STATUS_LABEL: Record<ConsentStatus, string> = {
  pending: '⏳ بانتظار الموافقة',
  approved: '✅ مُعتمد',
  rejected: '❌ مرفوض',
  revoked: '🚫 مسحوب',
};
