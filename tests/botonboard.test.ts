import { describe, it, expect } from 'vitest';
import { classifyTransition, missingPerms } from '../src/plugins/botonboard';
import { translate } from '../src/locales';

const t = (key: string, vars?: Record<string, string | number>) => translate('ar', key, vars);

describe('classifyTransition', () => {
  it('detects a fresh add (left → member)', () => {
    expect(classifyTransition('left', 'member')).toMatchObject({ added: true, promoted: false, removed: false });
  });
  it('detects an add straight as admin (left → administrator)', () => {
    expect(classifyTransition('left', 'administrator').added).toBe(true);
  });
  it('detects a promotion (member → administrator), not an add', () => {
    expect(classifyTransition('member', 'administrator')).toMatchObject({ added: false, promoted: true });
  });
  it('detects removal (member → left / administrator → kicked)', () => {
    expect(classifyTransition('member', 'left').removed).toBe(true);
    expect(classifyTransition('administrator', 'kicked').removed).toBe(true);
  });
  it('ignores an admin-rights tweak (administrator → administrator)', () => {
    expect(classifyTransition('administrator', 'administrator')).toMatchObject({ added: false, promoted: false, removed: false });
  });
});

describe('missingPerms', () => {
  const full = { status: 'administrator', can_delete_messages: true, can_restrict_members: true, can_pin_messages: true, can_invite_users: true };
  it('is empty when an admin has every right', () => {
    expect(missingPerms(full, t)).toEqual([]);
  });
  it('lists only the missing rights', () => {
    const miss = missingPerms({ status: 'administrator', can_pin_messages: true, can_invite_users: true }, t);
    expect(miss).toContain(t('onboard.perm.delete'));
    expect(miss).toContain(t('onboard.perm.restrict'));
    expect(miss).not.toContain(t('onboard.perm.pin'));
  });
  it('is empty for a non-admin (member) — the caller shows "make me admin" instead', () => {
    expect(missingPerms({ status: 'member' }, t)).toEqual([]);
  });
});

describe('onboard locale strings', () => {
  it('welcome interpolates the group title', () => {
    expect(t('onboard.welcome', { title: 'جروب تجريبي' })).toContain('جروب تجريبي');
  });
  it('has the key strings', () => {
    for (const k of ['onboard.need_admin', 'onboard.perms_ok', 'onboard.promoted', 'onboard.btn.commands']) {
      expect(t(k)).not.toBe(k); // resolved, not the raw key
    }
  });
});
