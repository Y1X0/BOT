import crypto from 'node:crypto';
import { env } from '../config/env';

/** Cookie signing key — dedicated secret or derived from the bot token. */
const SECRET = env.DASHBOARD_SECRET ?? crypto.createHash('sha256').update(env.BOT_TOKEN).digest('hex');
const SESSION_TTL_MS = 7 * 24 * 3600_000; // 7 days
export const SESSION_COOKIE = 'dash_session';

export interface TelegramLoginData {
  id: string | number;
  auth_date: string | number;
  hash: string;
  [key: string]: string | number;
}

/**
 * Verify a Telegram Login Widget payload per Telegram's algorithm:
 * HMAC-SHA256 of the data-check-string keyed by SHA256(bot_token) must equal
 * `hash`, and auth_date must be recent. Returns the user id or null.
 */
export function verifyTelegramLogin(data: TelegramLoginData): number | null {
  const { hash, ...rest } = data;
  if (!hash) return null;
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(env.BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (hmac !== hash) return null;
  const authDate = Number(data.auth_date) * 1000;
  if (!Number.isFinite(authDate) || Date.now() - authDate > 86_400_000) return null;
  return Number(data.id);
}

/** Create a signed, expiring session token for a user id. */
export function signSession(userId: number): string {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

/** Verify a session token; returns the user id or null. */
export function verifySession(token: string | undefined): number | null {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [userId, expiry, sig] = decoded.split('.');
    const payload = `${userId}.${expiry}`;
    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    if (Date.now() > Number(expiry)) return null;
    return Number(userId);
  } catch {
    return null;
  }
}

/** Parse a specific cookie value from a Cookie header (no dependency). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
