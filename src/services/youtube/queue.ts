import { createLogger } from '../../core/logger';

const log = createLogger('youtube:queue');

export type Job = () => Promise<void>;

interface ChatQueue {
  pending: Job[];
  running: number;
}

/**
 * Per-chat job queue. Each chat id gets an independent queue processed by up to
 * `concurrency` workers, so one group's downloads never block another's — there
 * is no global lock. Empty queues are dropped to keep memory bounded.
 */
export class QueueManager {
  private readonly chats = new Map<number, ChatQueue>();

  /** Current number of pending (not-yet-started) jobs for a chat. */
  pendingCount(chatId: number): number {
    return this.chats.get(chatId)?.pending.length ?? 0;
  }

  /** Total jobs (pending + running) for a chat. */
  size(chatId: number): number {
    const q = this.chats.get(chatId);
    return q ? q.pending.length + q.running : 0;
  }

  /**
   * Enqueue a job for `chatId`. Returns its 1-based position in line
   * (1 = starts immediately). `maxQueue` caps pending jobs; returns -1 if full.
   */
  enqueue(chatId: number, job: Job, concurrency: number, maxQueue: number): number {
    let q = this.chats.get(chatId);
    if (!q) {
      q = { pending: [], running: 0 };
      this.chats.set(chatId, q);
    }
    if (q.pending.length >= maxQueue) return -1;

    q.pending.push(job);
    const position = q.running + q.pending.length;
    this.pump(chatId, concurrency);
    return position;
  }

  private pump(chatId: number, concurrency: number): void {
    const q = this.chats.get(chatId);
    if (!q) return;
    while (q.running < concurrency && q.pending.length > 0) {
      const job = q.pending.shift()!;
      q.running += 1;
      void job()
        .catch((err) => log.error({ err, chatId }, 'Queue job failed'))
        .finally(() => {
          q.running -= 1;
          if (q.running === 0 && q.pending.length === 0) {
            this.chats.delete(chatId);
          } else {
            this.pump(chatId, concurrency);
          }
        });
    }
  }
}

export const youtubeQueue = new QueueManager();
