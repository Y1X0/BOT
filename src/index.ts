import { env } from './config/env';
import { logger } from './core/logger';
import { initSentry, captureError } from './core/sentry';
import { connectDatabase, disconnectDatabase, ensureSchema } from './core/database';
import { createBot, publishCommands } from './core/bot';
import { createServer, startServer } from './core/server';
import type { Server } from 'http';

// Update types the bot must receive. This MUST be passed explicitly: when it's
// omitted, Telegram reuses the previously-saved setting, so if the list was ever
// narrowed it stays narrowed forever — which is exactly how `channel_post`
// (needed to index audio posted to the storage channel) silently goes missing
// even when the bot is a channel admin.
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query',
  'inline_query',
  'chat_member',
  'my_chat_member',
  'chat_join_request',
] as const;

async function main(): Promise<void> {
  logger.info({ mode: env.BOT_MODE, env: env.NODE_ENV }, 'Starting Telegram bot');

  await initSentry();
  await connectDatabase();
  await ensureSchema();
  await import('./services/roles.service')
    .then(async (m) => {
      await m.migrateRolesV2();
      await m.migrateRolesV3();
    })
    .catch(() => undefined);

  const { bot, plugins } = await createBot();

  // Bot-wide premium-emoji substitution: upgrade mapped normal emoji to premium
  // in every outgoing message. Install before launch; load the map now.
  const { installEmojiSubstitution, refreshEmojiMap } = await import('./services/emojiMap');
  installEmojiSubstitution(bot.telegram);
  await refreshEmojiMap();
  await import('./services/message-overrides.service').then((m) => m.refreshOverrides()).catch(() => undefined);
  await import('./services/channel.service').then((m) => m.refreshChannelReact()).catch(() => undefined);

  // Keep yt-dlp fresh so SoundCloud/YouTube search («يوت»/«اغنيه») doesn't break
  // when the host ships a stale binary. Non-blocking at boot, then daily.
  {
    const { ensureFreshYtdlp } = await import('./services/ytdlp-updater');
    void ensureFreshYtdlp();
    setInterval(() => void ensureFreshYtdlp(), 24 * 60 * 60 * 1000).unref();
  }

  const app = createServer(bot);
  const server: Server = await startServer(app);

  await publishCommands(bot, plugins);

  // Flush buffered command-usage counts to the DB periodically.
  {
    const { flushUsage } = await import('./services/usage.service');
    setInterval(() => void flushUsage(), 60_000).unref();
  }

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
      allowed_updates: [...ALLOWED_UPDATES],
    });
    logger.info({ url: `${env.WEBHOOK_DOMAIN}${path}` }, 'Webhook registered');
  } else {
    // Long polling. Do not await launch() — it resolves only when the bot stops.
    // Drop updates that piled up while the bot was down (e.g. a Render free
    // spin-down): otherwise, on wake it would flood every group with a backlog
    // of late replies all at once.
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => undefined);
    bot.launch({ dropPendingUpdates: true, allowedUpdates: [...ALLOWED_UPDATES] }, () => logger.info('Bot started (long polling)'));
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
    await import('./services/usage.service').then((m) => m.flushUsage()).catch(() => undefined);
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
  captureError(reason, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  captureError(err, { kind: 'uncaughtException' });
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  captureError(err, { kind: 'startup' });
  process.exit(1);
});
