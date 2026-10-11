import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { getGlobal } from '../../services/global.service';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:coursedl');

// Big YouTube videos (course lives, ~GBs) can't go through the normal /dl path:
// the Bot API caps uploads at 50MB. Instead we hand the job to the embedded
// streamer, which downloads with yt-dlp (cookies + Deno) and uploads via the
// assistant USER account (up to ~4GB). The streamer works in the background and
// calls /yt/done when finished.
const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

/** GlobalConfig key holding the current YouTube cookies.txt (self-refreshing). */
const COOKIES_KEY = 'yt_cookies';

// «نزّل <رابط يوتيوب>» (or حمّل/حمل/نزل), optionally followed by a quality.
const TRIGGER_RE = /^(?:نزّل|نزل|حمّل|حمل)\s+(https?:\/\/\S+)(?:\s+(\d{3,4}|best))?/i;
const YT_RE = /(?:youtube\.com|youtu\.be)/i;

/** The streamer calls back to the bot on the loopback port (merged service). */
function callbackUrl(): string {
  return `http://127.0.0.1:${env.PORT}/yt/done`;
}

async function startDownload(url: string, quality: string, chatId: number): Promise<string> {
  const cookies = (await getGlobal(COOKIES_KEY)) || undefined;
  const res = await fetch(`${STREAMER_URL}/ytdownload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
    body: JSON.stringify({ url, quality, chat_id: chatId, callback: callbackUrl(), cookies }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (data.ok) return 'started';
  return data.error || 'unreachable';
}

const START_ERRORS: Record<string, string> = {
  starting: '⏳ الخدمة لسه قيد التشغيل، جرّب بعد لحظات.',
  unauthorized: '⚠️ خطأ مصادقة مع خدمة التنزيل.',
  unreachable: '🎧 خدمة التنزيل غير متصلة الآن.',
  bad_request: '❌ رابط غير صالح.',
};

async function handle(ctx: BotContext, url: string, quality: string): Promise<void> {
  if (!ctx.chat) return;
  if (!STREAMER_URL) {
    await ctx.reply('📥 خدمة التنزيل الكبيرة مش مفعّلة (الستريمر المدموج غير مهيّأ).').catch(() => undefined);
    return;
  }
  // Owner/admins only — these downloads are heavy and go to Saved Messages.
  if (!ctx.state.isStaff) {
    await ctx.reply('🔒 هذا الأمر للإدارة فقط.').catch(() => undefined);
    return;
  }
  const status = await startDownload(url, quality, ctx.chat.id).catch((err) => {
    log.warn({ err }, 'startDownload failed');
    return 'unreachable';
  });
  if (status === 'started') {
    await ctx
      .reply(
        `⏳ <b>بلّشت التنزيل</b> (${quality === 'best' ? 'أفضل دقة' : quality + 'p'}).\n` +
          'بينزّل على السحابة ويوصلك بـ «الرسائل المحفوظة» لما يخلص — بوصلك إشعار هون. 👌',
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  } else {
    await ctx.reply(START_ERRORS[status] || START_ERRORS.unreachable).catch(() => undefined);
  }
}

export const courseDlPlugin: Plugin = {
  name: 'coursedl',
  description: 'Download large YouTube videos (course lives) to Telegram via the assistant account',
  commands: [{ command: 'ytget', description: '⬇️ نزّل فيديو يوتيوب كبير: /ytget <رابط> [دقة]' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('ytget', async (ctx) => {
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const url = parts.find((p) => /^https?:\/\//i.test(p));
      const quality = parts.find((p) => /^(\d{3,4}|best)$/i.test(p)) || '720';
      if (!url || !YT_RE.test(url)) {
        await ctx.reply('⬇️ أرسل: <code>/ytget رابط_يوتيوب [دقة]</code>', { parse_mode: 'HTML' }).catch(() => undefined);
        return;
      }
      await handle(ctx, url, quality.toLowerCase());
    });

    // Natural Arabic trigger: «نزّل <رابط يوتيوب> [دقة]».
    bot.hears(TRIGGER_RE, async (ctx) => {
      const m = ctx.message.text.match(TRIGGER_RE);
      if (!m) return;
      const url = m[1];
      if (!YT_RE.test(url)) return; // only YouTube — let other handlers take non-YT links
      const quality = (m[2] || '720').toLowerCase();
      await handle(ctx, url, quality);
    });
  },
};
