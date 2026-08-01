import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../core/context';
import { ensureChat, getLocale } from '../services/settings.service';
import { makeTranslator } from '../locales';
import { resolveRole } from '../utils/permissions';
import { hasRole } from '../utils/permissions';
import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('context-mw');

/**
 * Enrich every update with locale + translator, and for group chats also
 * bootstrap the Chat/Settings rows and cache them on ctx.state.
 * Role is resolved lazily but cached here for group messages.
 */
export const contextMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const chat = ctx.chat;

  if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
    try {
      const settings = await ensureChat(chat.id, chat.title, chat.type);
      ctx.state.settings = settings;
    } catch (err) {
      log.error({ err, chatId: chat.id }, 'Failed to bootstrap chat settings');
    }
    const locale = await getLocale(chat.id).catch(() => env.DEFAULT_LANGUAGE);
    ctx.state.locale = locale;
    ctx.state.t = makeTranslator(locale);
  } else {
    ctx.state.locale = env.DEFAULT_LANGUAGE;
    ctx.state.t = makeTranslator(env.DEFAULT_LANGUAGE);
  }

  // Resolve role once for messages from a user (cached on state).
  if (ctx.from && chat) {
    const role = await resolveRole(ctx);
    ctx.state.role = role;
    ctx.state.isStaff = hasRole(role, 'moderator');
  }

  await next();
};
