import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../core/context';
import { recordCommand } from '../services/usage.service';
import { matchAlias } from '../plugins/aliases';

/**
 * Count command usage — both slash commands (/id) and Arabic aliases (ايدي),
 * resolved to the same canonical command name. Read-only: always calls next().
 * Placed early so it sees the original text before any handler consumes it.
 */
export const usageMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const text = (ctx.message as { text?: string } | undefined)?.text;
  if (text) {
    let command: string | null = null;
    if (text.startsWith('/')) {
      command = text.slice(1).split(/[\s@]/)[0].toLowerCase() || null;
    } else {
      const rewritten = matchAlias(text); // e.g. "ايدي" → "/id"
      if (rewritten) command = rewritten.split(' ')[0].slice(1).toLowerCase();
    }
    if (command) recordCommand(command);
  }
  return next();
};
