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
  // Cap request bodies — Telegram updates and streamer callbacks are small, so a
  // tight limit blocks large-payload DoS without affecting legitimate traffic.
  app.use(express.json({ limit: '512kb' }));

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

  // Bulk-import progress from the streamer → relayed to whoever started it.
  app.post('/import/progress', async (req, res): Promise<void> => {
    const token = process.env.STREAMER_TOKEN || '';
    if (!token || req.header('X-Token') !== token) {
      res.status(401).json({ ok: false });
      return;
    }
    const { chat_id, text } = (req.body ?? {}) as { chat_id?: number | string; text?: string };
    if (!chat_id || !text) {
      res.status(400).json({ ok: false });
      return;
    }
    await bot.telegram.sendMessage(Number(chat_id), String(text)).catch(() => undefined);
    res.json({ ok: true });
  });

  // The live voice-chat guard (streamer) calls this the instant it detects an
  // account matching the flood signature (recent join + unmuted + actively
  // transmitting), so the bot can alert the group/owner. Authenticated with
  // STREAMER_TOKEN.
  app.post('/vc/guard', async (req, res): Promise<void> => {
    const token = process.env.STREAMER_TOKEN || '';
    if (!token || req.header('X-Token') !== token) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as {
      chat_id?: number | string;
      event?: string;
      account?: { id?: number; name?: string; username?: string | null };
      joined_ago?: number;
      reasons?: string[];
      muted?: boolean;
      reason?: string;
    };
    if (!body.chat_id) {
      res.status(400).json({ ok: false, error: 'bad_request' });
      return;
    }
    const chatId = Number(body.chat_id);
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
      if (body.event === 'threat' && body.account) {
        const a = body.account;
        const uname = a.username ? ` @${esc(String(a.username))}` : '';
        const reasons = (body.reasons ?? []).map((r) => esc(String(r))).join('، ');
        const acted = body.muted
          ? '🔇 <b>تم كتمه تلقائياً</b> — الكول محمي.'
          : '⚠️ <b>غير مكتوم</b> — تصرّف يدوياً بسرعة.';
        const text =
          '🚨 <b>حارس الكول — حساب مشبوه</b>\n' +
          '━━━━━━━━━━━━━\n' +
          `👤 <b>${esc(String(a.name || 'بلا اسم'))}</b>${uname}\n` +
          `🆔 <code>${a.id}</code>\n` +
          `⏱ انضمّ قبل ${Math.max(0, Number(body.joined_ago ?? 0))}ث وبدأ يبثّ فوراً\n` +
          (reasons ? `📌 ${reasons}\n` : '') +
          '━━━━━━━━━━━━━\n' +
          `${acted}\n🚫 للطرد: <code>/ban</code> أو <code>/kick</code> على الحساب.`;
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => undefined);
      } else if (body.event === 'stopped') {
        await bot.telegram
          .sendMessage(chatId, `🛡 توقّف حارس الكول (${esc(String(body.reason || 'انتهى الكول'))}).`)
          .catch(() => undefined);
      }
      res.json({ ok: true });
    } catch (err) {
      log.warn({ err }, 'vc guard callback failed');
      res.status(500).json({ ok: false });
    }
  });

  // The streamer calls this when a big YouTube download (course video) finishes
  // or fails. We persist the refreshed cookies (self-refresh, so the login stays
  // alive) and tell the requester in their chat. Authenticated with STREAMER_TOKEN.
  app.post('/yt/done', async (req, res): Promise<void> => {
    const token = process.env.STREAMER_TOKEN || '';
    if (!token || req.header('X-Token') !== token) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    const { chat_id, ok, error, title, cookies } = (req.body ?? {}) as {
      chat_id?: number | string;
      ok?: boolean;
      error?: string;
      title?: string;
      cookies?: string;
    };
    // Persist refreshed cookies so the next run uses a fresh (non-expiring) copy.
    if (typeof cookies === 'string' && cookies.includes('\t')) {
      const { setGlobal } = await import('../services/global.service');
      await setGlobal('yt_cookies', cookies).catch(() => undefined);
    }
    if (chat_id) {
      const YT_ERRORS: Record<string, string> = {
        botwall: '❌ يوتيوب طلب تأكيد (الكوكيز غالباً منتهية). جدّد ملف الكوكيز وجرّب تاني.',
        private: '🔒 الفيديو خاص أو للأعضاء فقط — حساب الكوكيز ما عنده صلاحية له.',
        notlive: '⏳ البث لسه ما بدأ (أو بريمير مجدول). استنى يبدأ البث وجرّب بعدين.',
        unavailable: '🚫 الفيديو غير متاح (محذوف أو مقيّد بالمنطقة).',
        format: '❌ الدقة المطلوبة غير متاحة، جرّب دقة أقل (مثلاً 480).',
        nospace: '💾 مساحة السيرفر امتلأت (الفيديو كبير). جرّب دقة أقل مثل 360.',
        upload: '⚠️ نزّل الفيديو بس فشل رفعه لتيليجرام، حاول مرة ثانية.',
        failed: '⚠️ تعذّر التنزيل، تأكد من الرابط وحاول مرة ثانية.',
      };
      const text = ok
        ? `✅ <b>خلص التنزيل</b>\n<code>${String(title || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</code>\nشوف «الرسائل المحفوظة» بتيليجرام. 🎉`
        : YT_ERRORS[error || 'failed'] || YT_ERRORS.failed;
      await bot.telegram.sendMessage(Number(chat_id), text, { parse_mode: 'HTML' }).catch(() => undefined);
    }
    res.json({ ok: true });
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
