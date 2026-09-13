/**
 * Pure monetization logic: plan catalogue, pricing math, referral commission.
 * No I/O here — the service layer resolves live prices/percent (which the owner
 * can edit from the dashboard) and passes them in. Kept pure so it's testable.
 */

export type PlanId = 'week' | 'month' | 'year';

export interface Plan {
  id: PlanId;
  days: number;
  label: string; // Arabic label
}

/** The subscription plans, in display order. Prices are resolved separately. */
export const PLANS: Plan[] = [
  { id: 'week', days: 7, label: 'أسبوع' },
  { id: 'month', days: 30, label: 'شهر' },
  { id: 'year', days: 365, label: 'سنة' },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** Extend an existing (possibly expired) expiry by a plan's duration. Renewing
 *  while still active stacks onto the remaining time; renewing after expiry
 *  starts from now. */
export function extendExpiry(current: Date | null | undefined, days: number, now: Date = new Date()): Date {
  const base = current && current.getTime() > now.getTime() ? current.getTime() : now.getTime();
  return new Date(base + days * 24 * 3600_000);
}

export function isActive(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && expiresAt.getTime() > now.getTime();
}

/** Whole days left until expiry (0 if expired). */
export function daysLeft(expiresAt: Date | null | undefined, now: Date = new Date()): number {
  if (!expiresAt) return 0;
  const ms = expiresAt.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / (24 * 3600_000)) : 0;
}

/** Referral commission (in Stars-equivalent credits) for a paid sub of `stars`
 *  at `percent`%. Floored to a whole credit; never negative. */
export function referralCommission(stars: number, percent: number): number {
  if (stars <= 0 || percent <= 0) return 0;
  return Math.floor((stars * percent) / 100);
}

/** Parse a /start referral payload: "ref_12345" → 12345 (bigint), else null. */
export function parseReferralPayload(payload: string | undefined): bigint | null {
  if (!payload) return null;
  const m = /^ref_(\d{3,20})$/.exec(payload.trim());
  if (!m) return null;
  try {
    return BigInt(m[1]);
  } catch {
    return null;
  }
}
