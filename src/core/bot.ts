import { Telegraf } from 'telegraf';
import { env } from '../config/env';
import type { BotContext } from './context';
import { createLogger } from './logger';
import { contextMiddleware } from '../middlewares/context.middleware';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware';
import { antispamMiddleware } from '../middlewares/antispam.middleware';
import { loggingMiddleware } from '../middlewares/logging.middleware';
import { moderationMiddleware } from '../middlewares/moderation.middleware';
import { logOutgoing } from '../services/logging.service';
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
    // Point at a self-hosted Local Bot API server when provided (enables
    // uploads up to 2000MB instead of the cloud API's 50MB cap).
    ...(env.TELEGRAM_API_ROOT ? { telegram: { apiRoot: env.TELEGRAM_API_ROOT } } : {}),
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

  // Log the bot's own outgoing DMs so per-user conversations show both sides.
  if (env.MESSAGE_LOG_ENABLED) {
    const originalSend = bot.telegram.sendMessage.bind(bot.telegram);
    bot.telegram.sendMessage = ((chatId: number | string, text: string, extra?: unknown) => {
      if (typeof chatId === 'number' && typeof text === 'string') void logOutgoing(chatId, text);
      return originalSend(chatId, text, extra as never);
    }) as typeof bot.telegram.sendMessage;
  }

  log.info({ count: plugins.length }, 'Bot created');
  return { bot, plugins };
}

/**
 * Curated commands shown in Telegram's "/" autocomplete menu. Every other
 * command still works (by typing it, via an Arabic alias, or through /menu) —
 * this only keeps the popup short and clean instead of listing 150+ commands.
 * Edit this list to show/hide a command in the popup.
 */
export const MENU_COMMANDS = [
  'menu', // ← the gateway to everything, kept first
  'help',
  'id',
  'rules',
  'prayer',
  'quiz',
  'balance',
  'pet',
  'song',
  'pdf',
  'checkup',
];

/** Publish the curated command list to Telegram (autocomplete menu). */
export async function publishCommands(
  bot: Telegraf<BotContext>,
  plugins: Plugin[],
): Promise<void> {
  const all = new Map(
    plugins
      .flatMap((p) => p.commands ?? [])
      .filter((c) => !c.staffOnly)
      .map((c) => [c.command, c.description] as const),
  );
  // Keep only whitelisted commands, in the whitelist's order.
  const commands = MENU_COMMANDS.filter((c) => all.has(c)).map((c) => ({ command: c, description: all.get(c)! }));

  await bot.telegram.setMyCommands(commands).catch((err) => {
    log.warn({ err }, 'Failed to set command menu');
  });
}
