import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { signSession, verifySession, verifyTelegramLogin } from '../src/dashboard/auth';

const BOT_TOKEN = process.env.BOT_TOKEN!;

describe('dashboard sessions', () => {
  it('round-trips a signed session', () => {
    const token = signSession(42);
    expect(verifySession(token)).toBe(42);
  });

  it('rejects a tampered session', () => {
    const token = signSession(42);
    expect(verifySession(token.slice(0, -3) + 'xyz')).toBeNull();
    expect(verifySession('garbage')).toBeNull();
    expect(verifySession(undefined)).toBeNull();
  });
});

describe('telegram login verification', () => {
  function sign(data: Record<string, string | number>): string {
    const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
    const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    return crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  }

  it('accepts a correctly-signed recent login', () => {
    const base = { id: 555, auth_date: Math.floor(Date.now() / 1000), first_name: 'Ali' };
    const hash = sign(base);
    expect(verifyTelegramLogin({ ...base, hash })).toBe(555);
  });

  it('rejects a bad hash', () => {
    const base = { id: 555, auth_date: Math.floor(Date.now() / 1000) };
    expect(verifyTelegramLogin({ ...base, hash: 'deadbeef' })).toBeNull();
  });

  it('rejects a stale login', () => {
    const base = { id: 555, auth_date: Math.floor(Date.now() / 1000) - 999999 };
    const hash = sign(base);
    expect(verifyTelegramLogin({ ...base, hash })).toBeNull();
  });
});
