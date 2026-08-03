import { describe, it, expect, beforeEach } from 'vitest';
import { msPending, isAwaitingMusaraha } from '../src/plugins/musaraha/state';

describe('musaraha state', () => {
  beforeEach(() => msPending.clear());

  it('tracks who is composing an anonymous message', () => {
    expect(isAwaitingMusaraha(111)).toBe(false);
    msPending.set(111, 222);
    expect(isAwaitingMusaraha(111)).toBe(true);
    expect(msPending.get(111)).toBe(222);
  });

  it('clears after delivery', () => {
    msPending.set(111, 222);
    msPending.delete(111);
    expect(isAwaitingMusaraha(111)).toBe(false);
  });
});
