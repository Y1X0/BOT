import type { Context } from 'telegraf';
import type { ChatSettings } from '@prisma/client';
import type { Role } from '../utils/permissions';
import type { Locale } from '../locales';

/**
 * Extended Telegraf context. Middlewares progressively enrich `ctx.state`
 * so downstream handlers can rely on resolved settings / role / translator.
 */
export interface BotContext extends Context {
  state: {
    /** Cached chat settings (loaded by settings middleware for group chats). */
    settings?: ChatSettings;
    /** Resolved role of the message sender in the current chat. */
    role?: Role;
    /** True if the sender is owner/admin/moderator. */
    isStaff?: boolean;
    /** Resolved locale for the chat. */
    locale?: Locale;
    /** Translation helper bound to the resolved locale. */
    t?: (key: string, vars?: Record<string, string | number>) => string;
  };
}
