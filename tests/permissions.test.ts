import { describe, it, expect } from 'vitest';
import { hasRole, isBotOwner, canActOn, rankOf, ROLES } from '../src/utils/permissions';

describe('permissions — unified 6-tier hierarchy', () => {
  it('has exactly the six roles, ordered high→low', () => {
    expect([...ROLES]).toEqual(['owner', 'supervisor', 'manager', 'admin', 'vip', 'member']);
  });

  it('ranks are strictly descending down the list', () => {
    for (let i = 1; i < ROLES.length; i++) {
      expect(rankOf(ROLES[i - 1])).toBeGreaterThan(rankOf(ROLES[i]));
    }
  });

  it('owner outranks everyone', () => {
    for (const r of ROLES) if (r !== 'owner') expect(hasRole('owner', r)).toBe(true);
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
});

describe('canActOn — nobody acts on equal or higher rank', () => {
  it('acts only strictly downward', () => {
    expect(canActOn('owner', 'supervisor')).toBe(true);
    expect(canActOn('supervisor', 'manager')).toBe(true);
    expect(canActOn('manager', 'admin')).toBe(true);
    expect(canActOn('admin', 'vip')).toBe(true);
    expect(canActOn('admin', 'member')).toBe(true);
  });

  it('refuses equal rank', () => {
    expect(canActOn('admin', 'admin')).toBe(false);
    expect(canActOn('manager', 'manager')).toBe(false);
    expect(canActOn('owner', 'owner')).toBe(false);
  });

  it('refuses acting upward', () => {
    expect(canActOn('admin', 'manager')).toBe(false);
    expect(canActOn('vip', 'admin')).toBe(false);
    expect(canActOn('manager', 'owner')).toBe(false);
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
