import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../core/context';
import { matchFilter } from '../services/filters.service';
import { containsBadword } from '../services/badwords';
import { addWarning } from '../services/moderation.service';
import { logAction } from '../services/moderation.service';
import { deleteMessage, muteUser, applyWarnAction } from '../utils/moderation-actions';
import { displayName } from '../utils/format';
import { createLogger } from '../core/logger';

const log = createLogger('antispam-mw');

/** Sliding window of recent message timestamps + last text, per user+chat. */
interface FloodState {
  timestamps: number[];
  lastText?: string;
  repeatCount: number;
}
const floodMap = new Map<string, FloodState>();

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, state] of floodMap) {
    state.timestamps = state.timestamps.filter((t) => t > cutoff);
    if (state.timestamps.length === 0) floodMap.delete(key);
  }
}, 60_000).unref?.();

const URL_REGEX = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i;

/**
 * Anti-spam pipeline. Runs before command handling for group text messages.
 * Skips staff. Enforces (in order): banned words, anti-link, flood/repeat.
 * Returns early (dropping the update) when it takes a moderation action.
 */
export const antispamMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const chat = ctx.chat;
  const from = ctx.from;
  const settings = ctx.state.settings;
  const t = ctx.state.t!;

  if (
    !chat ||
    !from ||
    !settings ||
    (chat.type !== 'group' && chat.type !== 'supergroup')
  ) {
    return next();
  }

  if (from.is_bot) return next();

  const text = (ctx.message as { text?: string; caption?: string } | undefined)?.text
    ?? (ctx.message as { caption?: string } | undefined)?.caption;

  // 0) Profanity/insult filter (opt-in). Runs BEFORE the staff bypass and
  // independently of antispamEnabled, so insults are caught for everyone. Staff
  // messages are still deleted when possible, but staff aren't warned/escalated.
  if ((settings as { badwordsEnabled?: boolean }).badwordsEnabled && text && containsBadword(text)) {
    await deleteMessage(ctx);
    if (!ctx.state.isStaff) {
      await handleWarn(ctx, from, settings, t, 'insult');
    }
    await ctx.reply('🚫 يُمنع السب والشتم والألفاظ المسيئة في المجموعة.').catch(() => undefined);
    return; // handled
  }

  // Never moderate staff or the bot itself for the remaining spam checks.
  if (ctx.state.isStaff) return next();
  if (!settings.antispamEnabled) return next();

  // 1) Banned words filter.
  if (settings.filtersEnabled && text) {
    const hit = await matchFilter(chat.id, text);
    if (hit) {
      await deleteMessage(ctx);
      if (hit.action === 'warn') {
        await handleWarn(ctx, from, settings, t, 'banned word');
      } else if (hit.action === 'mute') {
        const oneHour = Math.floor(Date.now() / 1000) + 3600;
        await muteUser(ctx, from.id, oneHour);
      }
      await ctx.reply(t('mod.filter_hit')).catch(() => undefined);
      return; // handled
    }
  }

  // 2) Anti-link.
  if (settings.antiLinkEnabled && text && URL_REGEX.test(text)) {
    await deleteMessage(ctx);
    await ctx.reply(t('mod.antilink')).catch(() => undefined);
    return;
  }

  // 3) Anti-forward.
  if (
    settings.antiForwardEnabled &&
    (ctx.message as { forward_origin?: unknown } | undefined)?.forward_origin
  ) {
    await deleteMessage(ctx);
    return;
  }

  // 4) Flood + repeated-message detection.
  if (settings.floodEnabled) {
    const key = `${chat.id}:${from.id}`;
    const now = Date.now();
    const windowMs = settings.floodWindowSec * 1000;
    const state = floodMap.get(key) ?? { timestamps: [], repeatCount: 0 };

    state.timestamps = state.timestamps.filter((ts) => now - ts < windowMs);
    state.timestamps.push(now);

    if (text && text === state.lastText) {
      state.repeatCount += 1;
    } else {
      state.repeatCount = 0;
      state.lastText = text;
    }
    floodMap.set(key, state);

    const flooding = state.timestamps.length > settings.floodLimit;
    const repeating = state.repeatCount >= 3;

    if (flooding || repeating) {
      state.timestamps = [];
      state.repeatCount = 0;
      const oneHour = Math.floor(now / 1000) + 3600;
      await muteUser(ctx, from.id, oneHour);
      await logAction(chat.id, 'auto_mute_flood', from.id, from.id, flooding ? 'flood' : 'repeat');
      await ctx
        .reply(t('mod.flood_warning', { name: displayName(from) }))
        .catch(() => undefined);
      log.info({ chatId: chat.id, userId: from.id }, 'Auto-muted for flooding');
      return;
    }
  }

  return next();
};

/** Add a warning and escalate if the configured limit is exceeded. */
async function handleWarn(
  ctx: BotContext,
  from: { id: number; first_name?: string },
  settings: { maxWarnings: number; warnAction: string },
  t: (k: string, v?: Record<string, string | number>) => string,
  reason: string,
): Promise<void> {
  const count = await addWarning(ctx.chat!.id, from.id, ctx.botInfo?.id ?? 0, reason);
  if (count >= settings.maxWarnings) {
    const applied = await applyWarnAction(ctx, from.id, settings.warnAction);
    if (applied !== 'none') {
      await ctx
        .reply(t(`mod.action_${applied}`, { name: displayName(from) }))
        .catch(() => undefined);
    }
  }
}
