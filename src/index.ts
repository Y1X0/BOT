import { env } from './config/env';
import { logger } from './core/logger';
import { connectDatabase, disconnectDatabase, ensureSchema } from './core/database';
import { createBot, publishCommands } from './core/bot';
import { createServer, startServer } from './core/server';
import type { Server } from 'http';

async function main(): Promise<void> {
  logger.info({ mode: env.BOT_MODE, env: env.NODE_ENV }, 'Starting Telegram bot');

  await connectDatabase();
  await ensureSchema();

  const { bot, plugins } = await createBot();

  // Bot-wide premium-emoji substitution: upgrade mapped normal emoji to premium
  // in every outgoing message. Install before launch; load the map now.
  const { installEmojiSubstitution, refreshEmojiMap } = await import('./services/emojiMap');
  installEmojiSubstitution(bot.telegram);
  await refreshEmojiMap();

  const app = createServer(bot);
  const server: Server = await startServer(app);

  await publishCommands(bot, plugins);

  // Periodic message-log retention cleanup (owner dashboard, opt-in).
  if (env.MESSAGE_LOG_ENABLED) {
    const { cleanupOldLogs } = await import('./services/logging.service');
    const runCleanup = () =>
      cleanupOldLogs(env.MESSAGE_LOG_RETENTION_DAYS)
        .then((n) => n && logger.info({ deleted: n }, 'Pruned old message logs'))
        .catch(() => undefined);
    void runCleanup();
    setInterval(() => void runCleanup(), 6 * 3600_000).unref();
  }

  if (env.BOT_MODE === 'webhook') {
    if (!env.WEBHOOK_DOMAIN) {
      throw new Error('WEBHOOK_DOMAIN is required when BOT_MODE=webhook');
    }
    const path = env.WEBHOOK_PATH.startsWith('/') ? env.WEBHOOK_PATH : `/${env.WEBHOOK_PATH}`;
    await bot.telegram.setWebhook(`${env.WEBHOOK_DOMAIN}${path}`, {
      secret_token: env.WEBHOOK_SECRET,
    });
    logger.info({ url: `${env.WEBHOOK_DOMAIN}${path}` }, 'Webhook registered');
  } else {
    // Long polling. Do not await launch() — it resolves only when the bot stops.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
    bot.launch(() => logger.info('Bot started (long polling)'));
  }

  // --- Graceful shutdown ---
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    try {
      bot.stop(signal);
    } catch {
      /* already stopped */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await import('./services/pdf/browser').then((m) => m.closeBrowser()).catch(() => undefined);
    await disconnectDatabase();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('Bot is up and running ✅');
}

// Fail loud on unexpected top-level errors.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
