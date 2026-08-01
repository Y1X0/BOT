import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../core/context';
import { env } from '../config/env';

/**
 * Lightweight in-memory sliding-window rate limiter keyed by user+chat.
 * Protects the bot from command spam. For multi-instance deployments this
 * should be swapped for a Redis-backed store (see docs), but for a single
 * Render instance in-memory is correct and dependency-free.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodically evict stale buckets to bound memory.
const EVICT_INTERVAL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, EVICT_INTERVAL).unref?.();

export const rateLimitMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  // Only throttle command-like text; let normal chatter through.
  const text = (ctx.message as { text?: string } | undefined)?.text;
  const isCommand = typeof text === 'string' && text.startsWith('/');
  if (!isCommand || !ctx.from || !ctx.chat) return next();

  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + env.RATE_LIMIT_WINDOW_MS });
    return next();
  }

  bucket.count += 1;
  if (bucket.count > env.RATE_LIMIT_MAX) {
    // Silently drop — replying would itself be spammable.
    return;
  }
  return next();
};
