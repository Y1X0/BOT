import type { Telegraf, Telegram } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import { stat } from 'node:fs/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { downloadVideo, downloadAudio, type DlError, type DlMode } from '../../services/downloader';
import { youtubeQueue } from '../../services/youtube/queue';
import { youtubeConfig } from '../../services/youtube/config';
import { TELEGRAM_SEND_LIMIT } from '../../services/youtube/config';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:downloader');

const URL_RE = /(https?:\/\/[^\s]+)/i;
/** Domains we auto-offer download when a link is posted (short-video platforms). */
const AUTO_DOMAINS =
  /(tiktok\.com|vm\.tiktok\.com|instagram\.com|instagr\.am|(^|\.)(twitter|x)\.com|fb\.watch|facebook\.com|snapchat\.com|pinterest\.|pin\.it|reddit\.com|redd\.it|youtube\.com|youtu\.be)/i;
/** Links that are never downloadable media — Telegram message/group/channel
 *  links. We must not offer to download these (it makes the bot look silly). */
const SKIP_DOMAINS = /https?:\/\/(t\.me|telegram\.(me|org|dog))\b/i;

const ERRORS: Record<DlError, string> = {
  notinstalled: '⚠️ خدمة التنزيل غير مهيّأة على الخادم.',
  unsupported: '❌ هذا الرابط غير مدعوم.',
  toolarge: '❌ الملف أكبر من حد تيليجرام (50MB).',
  private: '🔒 المحتوى خاص أو يحتاج تسجيل دخول.',
  failed: '⚠️ تعذّر التنزيل، تأكد أن الرابط صحيح.',
  timeout: '⌛ انتهى وقت التنزيل، حاول مرة ثانية.',
};

// Pending format choice, keyed by the prompt message id.
const pending = new Map<string, { url: string; silent: boolean }>();

export const downloaderPlugin: Plugin = {
  name: 'downloader',
  description: 'Download from any link as video or audio (TikTok, Reels, X, YouTube...)',
  commands: [{ command: 'dl', description: '⬇️ نزّل من رابط (فيديو أو صوت): /dl الرابط' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('dl', async (ctx) => {
      if (!env.DL_ENABLED) return void ctx.reply('⬇️ خدمة التنزيل غير مفعّلة.');
      const fromArg = ctx.message.text.split(/\s+/).slice(1).join(' ');
      const replied = (ctx.message as { reply_to_message?: { text?: string; caption?: string } }).reply_to_message;
      const text = fromArg || replied?.text || replied?.caption || '';
      const url = text.match(URL_RE)?.[1];
      if (!url) return void ctx.reply('⬇️ أرسل: /dl <رابط>\nأو ردّ على رسالة فيها رابط.');
      if (SKIP_DOMAINS.test(url)) return void ctx.reply('❌ روابط تيليجرام مش قابلة للتنزيل.');
      await offerChoice(ctx, url, false);
    });

    // Auto: a lone link (or a known platform link) → offer video/audio choice.
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      if (!env.DL_ENABLED || !env.DL_AUTO || !chat) return next();
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return next();
      const url = text.match(URL_RE)?.[1];
      if (!url) return next();
      // Never auto-offer for Telegram links (message/group/channel) — not media.
      if (SKIP_DOMAINS.test(url)) return next();
      const isLoneUrl = /^https?:\/\/\S+$/i.test(text);
      if (isLoneUrl || AUTO_DOMAINS.test(url)) {
        await offerChoice(ctx, url, true);
        return; // consumed
      }
      return next();
    });

    // User picked a format.
    bot.action(/^dl:(v|a)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const p = pending.get(key);
      if (!p) return void ctx.answerCbQuery('انتهت الصلاحية، أرسل الرابط ثانية.').catch(() => undefined);
      pending.delete(key);
      const mode: DlMode = ctx.match[1] === 'a' ? 'audio' : 'video';
      await ctx.answerCbQuery(mode === 'audio' ? '🎵 صوت' : '🎬 فيديو').catch(() => undefined);
      await ctx.deleteMessage().catch(() => undefined);
      await runDownload(ctx.telegram, ctx.chat!.id, p.url, mode, p.silent);
    });
  },
};

async function offerChoice(ctx: BotContext, url: string, silent: boolean): Promise<void> {
  if (!ctx.chat) return;
  const sent = await ctx
    .reply('📥 كيف تريد تنزيله؟', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🎬 فيديو', callback_data: 'dl:v' },
          { text: '🎵 صوت', callback_data: 'dl:a' },
        ]],
      },
    })
    .catch(() => undefined);
  if (sent) pending.set(`${ctx.chat.id}:${sent.message_id}`, { url, silent });
}

async function runDownload(telegram: Telegram, chatId: number, url: string, mode: DlMode, silent: boolean): Promise<void> {
  const status = await telegram
    .sendMessage(chatId, mode === 'audio' ? '🎵 جاري تنزيل الصوت...' : '🎬 جاري تنزيل الفيديو...')
    .catch(() => undefined);
  const statusId = status?.message_id;
  const editStatus = (t: string) => (statusId ? telegram.editMessageText(chatId, statusId, undefined, t).catch(() => undefined) : undefined);

  const job = async () => {
    try {
      await telegram.sendChatAction(chatId, mode === 'audio' ? 'upload_voice' : 'upload_video').catch(() => undefined);
      const result = mode === 'audio' ? await downloadAudio(url) : await downloadVideo(url);
      if ('error' in result) {
        if (result.error === 'unsupported' && silent) {
          if (statusId) await telegram.deleteMessage(chatId, statusId).catch(() => undefined);
          return;
        }
        await editStatus(ERRORS[result.error] + (result.reason ? `\n📄 ${result.reason}` : ''));
        return;
      }
      try {
        const { size } = await stat(result.filePath);
        if (size > TELEGRAM_SEND_LIMIT) return void (await editStatus(ERRORS.toolarge));
        const file = Input.fromLocalFile(result.filePath);
        if (mode === 'audio') {
          await telegram.sendAudio(chatId, file, { title: result.title, caption: `🎵 ${result.title}` });
        } else if (result.isVideo) {
          await telegram.sendVideo(chatId, file, { caption: `🎬 ${result.title}`, supports_streaming: true });
        } else {
          await telegram.sendDocument(chatId, file, { caption: `📎 ${result.title}` });
        }
        if (statusId) await telegram.deleteMessage(chatId, statusId).catch(() => undefined);
      } finally {
        await result.cleanup();
      }
    } catch (err) {
      log.error({ err, chatId }, 'download job error');
      await editStatus(ERRORS.failed);
    }
  };

  const position = youtubeQueue.enqueue(chatId, job, youtubeConfig.concurrentDownloadsPerGroup, youtubeConfig.maxQueuePerGroup);
  if (position === -1) await editStatus('⚠️ قائمة الانتظار ممتلئة، حاول لاحقاً.');
}
