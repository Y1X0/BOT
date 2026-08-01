import { describe, it, expect } from 'vitest';
import { hasRole, isBotOwner } from '../src/utils/permissions';

describe('permissions', () => {
  it('owner outranks everyone', () => {
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('owner', 'moderator')).toBe(true);
    expect(hasRole('owner', 'member')).toBe(true);
  });

  it('member does not satisfy elevated roles', () => {
    expect(hasRole('member', 'moderator')).toBe(false);
    expect(hasRole('member', 'admin')).toBe(false);
  });

  it('role satisfies its own level', () => {
    expect(hasRole('moderator', 'moderator')).toBe(true);
    expect(hasRole('admin', 'admin')).toBe(true);
  });

  it('recognizes configured bot owners from OWNER_IDS', () => {
    // setup.ts sets OWNER_IDS=111,222
    expect(isBotOwner(111)).toBe(true);
    expect(isBotOwner(222)).toBe(true);
    expect(isBotOwner(999)).toBe(false);
  });
});
