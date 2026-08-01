import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../core/context';
import { moderateText } from '../services/moderation-ai.service';
import { addWarning, logAction } from '../services/moderation.service';
import { deleteMessage, muteUser, kickUser, banUser } from '../utils/moderation-actions';
import { displayName } from '../utils/format';

/**
 * AI/heuristic moderation. Opt-in per chat (moderationEnabled). Scores group
 * messages and applies the chat's configured action to flagged content.
 * Skips staff. Runs after anti-spam, before command handling.
 */
export const moderationMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const chat = ctx.chat;
  const from = ctx.from;
  const settings = ctx.state.settings;
  if (
    !chat ||
    !from ||
    !settings?.moderationEnabled ||
    ctx.state.isStaff ||
    from.is_bot ||
    (chat.type !== 'group' && chat.type !== 'supergroup')
  ) {
    return next();
  }

  const text = (ctx.message as { text?: string; caption?: string } | undefined)?.text
    ?? (ctx.message as { caption?: string } | undefined)?.caption;
  if (!text) return next();

  const verdict = moderateText(text);
  if (!verdict.flagged || verdict.severity < 2) return next();

  await deleteMessage(ctx);
  await logAction(chat.id, `moderation_${verdict.category}`, ctx.botInfo?.id ?? 0, from.id, `severity=${verdict.severity}`);

  const action = settings.moderationAction;
  const name = displayName(from);
  if (action === 'ban') {
    await banUser(ctx, from.id);
    await ctx.reply(`🚫 تم حظر ${name} — محتوى مخالف (${verdict.category}).`).catch(() => undefined);
  } else if (action === 'kick') {
    await kickUser(ctx, from.id);
    await ctx.reply(`👢 تم طرد ${name} — محتوى مخالف (${verdict.category}).`).catch(() => undefined);
  } else if (action === 'mute') {
    await muteUser(ctx, from.id, Math.floor(Date.now() / 1000) + 3600);
    await ctx.reply(`🔇 تم كتم ${name} — محتوى مخالف (${verdict.category}).`).catch(() => undefined);
  } else {
    await addWarning(chat.id, from.id, ctx.botInfo?.id ?? 0, `moderation:${verdict.category}`);
    await ctx.reply(`⚠️ حُذفت رسالة ${name} — محتوى مخالف (${verdict.category}).`).catch(() => undefined);
  }
  // Message handled — stop the pipeline.
};
