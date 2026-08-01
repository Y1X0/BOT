import { describe, it, expect } from 'vitest';
import { QueueManager } from '../src/services/youtube/queue';

/** A deferred promise we can resolve manually to control job timing. */
function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Yield enough microtasks for queued .finally → pump → next job to run. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('YouTube per-chat queue', () => {
  it('runs jobs in one chat sequentially at concurrency 1', async () => {
    const qm = new QueueManager();
    const order: string[] = [];
    const d1 = defer();
    const d2 = defer();

    const p1 = qm.enqueue(1, async () => {
      order.push('a-start');
      await d1.promise;
      order.push('a-end');
    }, 1, 50);
    const p2 = qm.enqueue(1, async () => {
      order.push('b-start');
      await d2.promise;
      order.push('b-end');
    }, 1, 50);

    expect(p1).toBe(1);
    expect(p2).toBe(2);
    await flush();
    // Only the first job has started.
    expect(order).toEqual(['a-start']);

    d1.resolve();
    await flush();
    expect(order).toContain('a-end');
    expect(order).toContain('b-start');
    d2.resolve();
    await flush();
  });

  it('processes different chats independently (no global lock)', async () => {
    const qm = new QueueManager();
    const started: string[] = [];
    const dA = defer();
    const dB = defer();

    qm.enqueue(100, async () => {
      started.push('A');
      await dA.promise;
    }, 1, 50);
    qm.enqueue(200, async () => {
      started.push('B');
      await dB.promise;
    }, 1, 50);

    await flush();
    // Chat A being busy must NOT block chat B.
    expect(started.sort()).toEqual(['A', 'B']);
    dA.resolve();
    dB.resolve();
    await flush();
  });

  it('honors the per-chat queue cap', () => {
    const qm = new QueueManager();
    const noop = () => new Promise<void>(() => undefined); // never resolves
    expect(qm.enqueue(5, noop, 1, 2)).toBe(1); // running
    expect(qm.enqueue(5, noop, 1, 2)).toBe(2); // pending 1
    expect(qm.enqueue(5, noop, 1, 2)).toBe(3); // pending 2 (at cap)
    expect(qm.enqueue(5, noop, 1, 2)).toBe(-1); // full → rejected
  });
});
