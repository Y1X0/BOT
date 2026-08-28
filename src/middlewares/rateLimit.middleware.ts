import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../core/context';
import { env } from '../config/env';
import { matchAlias } from '../plugins/aliases';

/**
 * Lightweight in-memory sliding-window rate limiter keyed by user+chat.
 * Protects the bot from command spam — including Arabic-word commands (يوت،
 * زخرفه…) which don't start with "/", and button (callback) mashing, both of
 * which can trigger expensive work. Normal chatter is never throttled.
 *
 * For multi-instance deployments swap this for a Redis-backed store; for a
 * single instance in-memory is correct and dependency-free.
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

/** True for a message that resolves to a command — a real "/cmd" or an Arabic
 *  alias (يوت / زخرفه / …). The alias result is cached on ctx.state so the
 *  aliases plugin doesn't recompute it. */
function commandLike(ctx: BotContext, text?: string): boolean {
  if (typeof text !== 'string' || !text) return false;
  if (text.startsWith('/')) return true;
  const rewritten = matchAlias(text);
  (ctx.state as { aliasRewrite?: string | null }).aliasRewrite = rewritten;
  return rewritten !== null;
}

/** Consume one token from the bucket. Returns true when the action is allowed. */
function allow(key: string, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + env.RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

export const rateLimitMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const from = ctx.from;
  const chat = ctx.chat;
  if (!from || !chat) return next();

  // Button/callback mashing: throttle on its own (slightly looser) bucket, since
  // a single callback can kick off a download. Ack so the button stops spinning.
  if (ctx.callbackQuery) {
    if (!allow(`${chat.id}:${from.id}:cb`, env.RATE_LIMIT_MAX * 2)) {
      await ctx.answerCbQuery('⏳ تمهّل قليلاً').catch(() => undefined);
      return;
    }
    return next();
  }

  const text = (ctx.message as { text?: string } | undefined)?.text;
  if (!commandLike(ctx, text)) return next();

  // Silently drop over-limit commands — replying would itself be spammable.
  if (!allow(`${chat.id}:${from.id}`, env.RATE_LIMIT_MAX)) return;
  return next();
};
