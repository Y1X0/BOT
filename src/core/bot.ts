import { Telegraf } from 'telegraf';
import { env } from '../config/env';
import type { BotContext } from './context';
import { createLogger } from './logger';
import { contextMiddleware } from '../middlewares/context.middleware';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware';
import { antispamMiddleware } from '../middlewares/antispam.middleware';
import { loggingMiddleware } from '../middlewares/logging.middleware';
import { moderationMiddleware } from '../middlewares/moderation.middleware';
import { recordError } from './errors';
import { registerPlugins, type Plugin } from './plugin';
import { allPlugins } from '../plugins';

const log = createLogger('bot');

/**
 * Build and wire the Telegraf bot: global error trap, middleware pipeline,
 * then all feature plugins. Returns the bot plus the loaded plugin list
 * (used to publish the command menu).
 */
export async function createBot(): Promise<{
  bot: Telegraf<BotContext>;
  plugins: Plugin[];
}> {
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN, {
    handlerTimeout: 30_000,
  });

  // Global error boundary — never let a handler crash the process.
  bot.catch((err, ctx) => {
    log.error({ err, updateType: ctx.updateType }, 'Unhandled bot error');
    recordError(err instanceof Error ? err.message : String(err), ctx.updateType);
  });

  // Middleware pipeline order matters:
  // 1) enrich context (settings/locale/role)
  // 2) record message metadata (owner dashboard, opt-in)
  // 3) rate-limit commands
  // 4) anti-spam moderation (may short-circuit)
  // 5) plugins / command handlers
  bot.use(contextMiddleware);
  bot.use(loggingMiddleware);
  bot.use(rateLimitMiddleware);
  bot.use(antispamMiddleware);
  bot.use(moderationMiddleware);

  const plugins = await registerPlugins(bot, allPlugins);

  log.info({ count: plugins.length }, 'Bot created');
  return { bot, plugins };
}

/** Publish the public command list to Telegram (autocomplete menu). */
export async function publishCommands(
  bot: Telegraf<BotContext>,
  plugins: Plugin[],
): Promise<void> {
  const commands = plugins
    .flatMap((p) => p.commands ?? [])
    .filter((c) => !c.staffOnly)
    .map((c) => ({ command: c.command, description: c.description }));

  if (commands.length) {
    await bot.telegram.setMyCommands(commands).catch((err) => {
      log.warn({ err }, 'Failed to set command menu');
    });
  }
}
