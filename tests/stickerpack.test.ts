import { describe, it, expect } from 'vitest';
import { packName } from '../src/plugins/stickerpack/logic';
import { packState, isAwaitingPackTitle } from '../src/plugins/stickerpack/state';

describe('packName', () => {
  it('builds a valid set name ending with _by_<bot>', () => {
    const name = packName(123456, 'my_group_bot', 42042);
    expect(name).toBe('u123456_42042_by_my_group_bot');
    expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*_by_my_group_bot$/);
    expect(name).not.toMatch(/__/); // no consecutive underscores
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe('pack state', () => {
  it('tracks the title-awaiting step for the aliases guard', () => {
    packState.clear();
    expect(isAwaitingPackTitle(7)).toBe(false);
    packState.set(7, { step: 'title', kind: 'regular' });
    expect(isAwaitingPackTitle(7)).toBe(true);
    packState.set(7, { step: 'image', title: 'x', kind: 'emoji' });
    expect(isAwaitingPackTitle(7)).toBe(false);
  });
});
