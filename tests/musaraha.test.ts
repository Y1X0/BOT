import { describe, it, expect, beforeEach } from 'vitest';
import {
  msPending,
  isAwaitingMusaraha,
  msgToSender,
  isMusarahaReply,
  blockSender,
  isBlocked,
  blocked,
} from '../src/plugins/musaraha/state';

describe('musaraha state', () => {
  beforeEach(() => {
    msPending.clear();
    msgToSender.clear();
    blocked.clear();
  });

  it('tracks who is composing an anonymous message', () => {
    expect(isAwaitingMusaraha(111)).toBe(false);
    msPending.set(111, 222);
    expect(isAwaitingMusaraha(111)).toBe(true);
  });

  it('recognizes a native reply to a delivered anonymous message', () => {
    msgToSender.set('222:987', 111); // owner 222, msg 987 → sender 111
    expect(isMusarahaReply(222, 987)).toBe(true);
    expect(isMusarahaReply(222, 5)).toBe(false);
  });

  it('blocks a sender per owner', () => {
    expect(isBlocked(222, 111)).toBe(false);
    blockSender(222, 111);
    expect(isBlocked(222, 111)).toBe(true);
    expect(isBlocked(333, 111)).toBe(false); // scoped to the owner
  });
});
