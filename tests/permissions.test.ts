import { describe, it, expect } from 'vitest';
import { hasRole, isBotOwner, canActOn, rankOf, ROLES } from '../src/utils/permissions';

describe('permissions — unified 6-tier hierarchy', () => {
  it('has exactly the six roles, ordered high→low', () => {
    expect([...ROLES]).toEqual(['founder', 'owner', 'manager', 'admin', 'vip', 'member']);
  });

  it('ranks are strictly descending down the list', () => {
    for (let i = 1; i < ROLES.length; i++) {
      expect(rankOf(ROLES[i - 1])).toBeGreaterThan(rankOf(ROLES[i]));
    }
  });

  it('founder outranks everyone', () => {
    for (const r of ROLES) if (r !== 'founder') expect(hasRole('founder', r)).toBe(true);
  });

  it('a role satisfies its own level and everything below', () => {
    expect(hasRole('manager', 'admin')).toBe(true);
    expect(hasRole('manager', 'manager')).toBe(true);
    expect(hasRole('admin', 'manager')).toBe(false);
    expect(hasRole('vip', 'admin')).toBe(false);
  });

  it('member satisfies nothing elevated', () => {
    expect(hasRole('member', 'vip')).toBe(false);
    expect(hasRole('member', 'admin')).toBe(false);
  });

  it('founder/owner sit above manager (the new two-tier top)', () => {
    expect(hasRole('founder', 'owner')).toBe(true);
    expect(hasRole('owner', 'manager')).toBe(true);
    expect(hasRole('owner', 'founder')).toBe(false); // owner is NOT the founder
    expect(hasRole('manager', 'owner')).toBe(false);
  });

  it('a Telegram admin (→ admin rank) can moderate but not manage ranks', () => {
    expect(hasRole('admin', 'admin')).toBe(true); // daily moderation gate
    expect(hasRole('admin', 'manager')).toBe(false); // settings/rank gate
  });
});

describe('canActOn — nobody acts on equal or higher rank', () => {
  it('acts only strictly downward', () => {
    expect(canActOn('founder', 'owner')).toBe(true);
    expect(canActOn('owner', 'manager')).toBe(true);
    expect(canActOn('manager', 'admin')).toBe(true);
    expect(canActOn('admin', 'vip')).toBe(true);
    expect(canActOn('admin', 'member')).toBe(true);
  });

  it('refuses equal rank', () => {
    expect(canActOn('admin', 'admin')).toBe(false);
    expect(canActOn('manager', 'manager')).toBe(false);
    expect(canActOn('founder', 'founder')).toBe(false);
  });

  it('refuses acting upward', () => {
    expect(canActOn('admin', 'manager')).toBe(false);
    expect(canActOn('vip', 'admin')).toBe(false);
    expect(canActOn('manager', 'owner')).toBe(false);
  });
});

describe('punishment shield — only plain members can be punished', () => {
  // mute/kick/ban/restrict/tmute/tban refuse when rankOf(target) >= rankOf('vip').
  const shielded = (r: Parameters<typeof rankOf>[0]) => rankOf(r) >= rankOf('vip');
  it('protects every rank-holder from punishment', () => {
    for (const r of ['vip', 'admin', 'manager', 'owner', 'founder'] as const) {
      expect(shielded(r)).toBe(true);
    }
  });
  it('leaves plain members punishable', () => {
    expect(shielded('member')).toBe(false);
  });
});

describe('bot owners', () => {
  it('recognizes configured bot owners from OWNER_IDS', () => {
    // setup.ts sets OWNER_IDS=111,222
    expect(isBotOwner(111)).toBe(true);
    expect(isBotOwner(222)).toBe(true);
    expect(isBotOwner(999)).toBe(false);
  });
});
