import { Telegraf } from 'telegraf';
import { env } from '../config/env';
import type { BotContext } from './context';
import { createLogger } from './logger';
import { captureError } from './sentry';
import { contextMiddleware } from '../middlewares/context.middleware';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware';
import { antispamMiddleware } from '../middlewares/antispam.middleware';
import { loggingMiddleware } from '../middlewares/logging.middleware';
import { usageMiddleware } from '../middlewares/usage.middleware';
import { moderationMiddleware } from '../middlewares/moderation.middleware';
import { logOutgoing } from '../services/logging.service';
import { recordError } from './errors';
import { registerPlugins, type Plugin } from './plugin';
import { allPlugins } from '../plugins';
import { MENU } from '../plugins/menu/data';

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
    telegram: {
      // In webhook mode Telegraf otherwise sends the first reply of each update
      // as the webhook HTTP response, which BYPASSES telegram.callApi — and with
      // it the outgoing interceptor (premium-emoji + <b>→entities styling). Force
      // every reply through the API so styling/emoji always apply. Harmless in
      // polling mode.
      webhookReply: false,
      // Point at a self-hosted Local Bot API server when provided (enables
      // uploads up to 2000MB instead of the cloud API's 50MB cap).
      ...(env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : {}),
    },
  });

  // Global error boundary — never let a handler crash the process.
  bot.catch((err, ctx) => {
    log.error({ err, updateType: ctx.updateType }, 'Unhandled bot error');
    recordError(err instanceof Error ? err.message : String(err), ctx.updateType);
    captureError(err, { updateType: ctx.updateType, chatId: ctx.chat?.id });
  });

  // Middleware pipeline order matters:
  // 1) enrich context (settings/locale/role)
  // 2) record message metadata (owner dashboard, opt-in)
  // 3) rate-limit commands
  // 4) anti-spam moderation (may short-circuit)
  // 5) plugins / command handlers
  bot.use(contextMiddleware);
  bot.use(usageMiddleware);
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
  'checkup',
  'rules',
];

// Telegram command-name rules: 1–32 chars, lowercase a–z / 0–9 / _, and (per
// BotFather) must start with a letter — one bad name rejects the WHOLE call.
const VALID_CMD = /^[a-z][a-z0-9_]{0,31}$/;
const TG_MAX_COMMANDS = 100;

/**
 * Build the "/"-popup command list. Everyone sees the essentials + every
 * non-admin category from the /menu (so ~all useful commands are discoverable
 * by typing "/"); admins additionally get the moderation commands, scoped so
 * regular members don't see them. Capped at Telegram's 100-command limit.
 */
function buildCommandList(mode: 'general' | 'admin', descOf: (c: string) => string) {
  const out: { command: string; description: string }[] = [];
  const seen = new Set<string>();
  const add = (cmd: string, desc?: string): void => {
    if (out.length >= TG_MAX_COMMANDS || seen.has(cmd) || !VALID_CMD.test(cmd)) return;
    seen.add(cmd);
    const d = (desc || descOf(cmd) || cmd).slice(0, 200);
    out.push({ command: cmd, description: d });
  };
  for (const c of MENU_COMMANDS) add(c);
  if (mode === 'admin') {
    const adminCat = MENU.find((c) => c.key === 'admin');
    adminCat?.items.forEach((it) => add(it.cmd, it.desc)); // admin cmds first so they fit
  }
  for (const cat of MENU) {
    if (cat.key === 'admin') continue; // handled above / excluded for general
    cat.items.forEach((it) => add(it.cmd, it.desc));
  }
  return out;
}

/** Publish the command list to Telegram (autocomplete popup), by scope. */
export async function publishCommands(
  bot: Telegraf<BotContext>,
  plugins: Plugin[],
): Promise<void> {
  // Descriptions come from the curated /menu (Arabic) first, else the plugin's
  // own command description.
  const pluginDesc = new Map(plugins.flatMap((p) => p.commands ?? []).map((c) => [c.command, c.description] as const));
  const descOf = (c: string): string => pluginDesc.get(c) ?? '';

  const general = buildCommandList('general', descOf);
  const admin = buildCommandList('admin', descOf);

  // Default scope: everyone (and every chat) sees the general commands.
  await bot.telegram.setMyCommands(general).catch((err) => log.warn({ err }, 'set default commands failed'));
  // Admin scope: group admins (in every group) additionally see the moderation
  // commands — regular members never see them in the popup.
  await bot.telegram
    .setMyCommands(admin, { scope: { type: 'all_chat_administrators' } })
    .catch((err) => log.warn({ err }, 'set admin commands failed'));

  log.info({ general: general.length, admin: admin.length }, 'published command menus');
}
