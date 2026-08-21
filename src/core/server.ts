import express, { type Express } from 'express';
import type { Telegraf } from 'telegraf';
import type { BotContext } from './context';
import { env } from '../config/env';
import { prisma } from './database';
import { createLogger } from './logger';
import { createDashboardApi } from '../dashboard/api';
import { DASHBOARD_HTML } from '../dashboard/page';
import { sendCardVia } from '../plugins/music';

const log = createLogger('server');

/**
 * HTTP server providing:
 *  - GET /health   → liveness + DB check (used by Render health checks)
 *  - GET /         → simple status page
 *  - POST webhook  → (only in webhook mode) Telegram update ingestion
 */
export function createServer(bot: Telegraf<BotContext>): Express {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.json({ name: 'telegram-group-bot', status: 'running', mode: env.BOT_MODE });
  });

  // Web dashboard (opt-in): API + single-page UI.
  if (env.DASHBOARD_ENABLED) {
    app.use('/api', createDashboardApi(bot.telegram));
    app.get('/dashboard', (_req, res) => res.type('html').send(DASHBOARD_HTML));
    log.info('Web dashboard enabled at /dashboard');
  }

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ok', db: 'up', uptime: process.uptime() });
    } catch (err) {
      log.error({ err }, 'Health check DB failure');
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  // The voice-chat streamer calls this when a track auto-advances (a song ended
  // and the next queued one started), so the bot can post the now-playing card.
  // Authenticated with the shared STREAMER_TOKEN.
  app.post('/vc/nowplaying', async (req, res): Promise<void> => {
    const token = process.env.STREAMER_TOKEN || '';
    if (!token || req.header('X-Token') !== token) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    const { chat_id, title, uploader, duration, thumb } = (req.body ?? {}) as {
      chat_id?: number | string;
      title?: string;
      uploader?: string;
      duration?: number;
      thumb?: string;
    };
    if (!chat_id) {
      res.status(400).json({ ok: false, error: 'bad_request' });
      return;
    }
    try {
      await sendCardVia(bot.telegram, Number(chat_id), { ok: true, title, uploader, duration, thumb }, null);
      res.json({ ok: true });
    } catch (err) {
      log.warn({ err }, 'now-playing callback failed');
      res.status(500).json({ ok: false });
    }
  });

  // In webhook mode, mount Telegraf's callback at the secret path.
  if (env.BOT_MODE === 'webhook') {
    const path = env.WEBHOOK_PATH.startsWith('/')
      ? env.WEBHOOK_PATH
      : `/${env.WEBHOOK_PATH}`;
    app.use(bot.webhookCallback(path, { secretToken: env.WEBHOOK_SECRET }));
    log.info({ path }, 'Webhook callback mounted');
  }

  return app;
}

export function startServer(app: Express): Promise<ReturnType<Express['listen']>> {
  return new Promise((resolve) => {
    const server = app.listen(env.PORT, () => {
      log.info({ port: env.PORT }, 'HTTP server listening');
      resolve(server);
    });
  });
}
