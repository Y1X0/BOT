import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import { stat } from 'node:fs/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { downloadVideo, type DlError } from '../../services/downloader';
import { youtubeQueue } from '../../services/youtube/queue';
import { youtubeConfig } from '../../services/youtube/config';
import { TELEGRAM_SEND_LIMIT } from '../../services/youtube/config';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:downloader');

const URL_RE = /(https?:\/\/[^\s]+)/i;
/** Domains we auto-download when a link is posted (short-video platforms). */
const AUTO_DOMAINS =
  /(tiktok\.com|vm\.tiktok\.com|instagram\.com|instagr\.am|(^|\.)(twitter|x)\.com|fb\.watch|facebook\.com|snapchat\.com|pinterest\.|pin\.it|reddit\.com|redd\.it)/i;

const ERRORS: Record<DlError, string> = {
  notinstalled: '⚠️ خدمة التنزيل غير مهيّأة على الخادم.',
  unsupported: '❌ هذا الرابط غير مدعوم.',
  toolarge: '❌ الفيديو أكبر من حد تيليجرام (50MB).',
  private: '🔒 المحتوى خاص أو يحتاج تسجيل دخول.',
  failed: '⚠️ تعذّر تنزيل الرابط، تأكد أنه صحيح.',
  timeout: '⌛ انتهى وقت التنزيل، حاول مرة ثانية.',
};

export const downloaderPlugin: Plugin = {
  name: 'downloader',
  description: 'Download video from any link (TikTok, Reels, X, Facebook...)',
  commands: [{ command: 'dl', description: '⬇️ نزّل فيديو من رابط: /dl الرابط' }],

  register(bot: Telegraf<BotContext>) {
    // /dl <url>  (or reply to a message containing a link)
    bot.command('dl', async (ctx) => {
      if (!env.DL_ENABLED) return void ctx.reply('⬇️ خدمة التنزيل غير مفعّلة.');
      const fromArg = ctx.message.text.split(/\s+/).slice(1).join(' ');
      const replied = (ctx.message as { reply_to_message?: { text?: string; caption?: string } })
        .reply_to_message;
      const text = fromArg || replied?.text || replied?.caption || '';
      const url = text.match(URL_RE)?.[1];
      if (!url) {
        await ctx.reply('⬇️ أرسل: /dl <رابط الفيديو>\nأو ردّ على رسالة فيها رابط.');
        return;
      }
      await enqueueDownload(ctx, url);
    });

    // Auto-download: a message that is JUST a link (or contains a known
    // short-video link) is downloaded automatically — no command needed.
    // Works in groups AND in private chat with the bot.
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      if (!env.DL_ENABLED || !env.DL_AUTO || !chat) return next();
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return next();
      const url = text.match(URL_RE)?.[1];
      if (!url) return next();

      const isLoneUrl = /^https?:\/\/\S+$/i.test(text); // the whole message is a link
      if (isLoneUrl || AUTO_DOMAINS.test(url)) {
        // Silent on "unsupported" so ordinary (non-media) links don't spam.
        await enqueueDownload(ctx, url, { silentUnsupported: true });
        return; // consumed
      }
      return next();
    });
  },
};

async function enqueueDownload(
  ctx: BotContext,
  url: string,
  opts: { silentUnsupported?: boolean } = {},
): Promise<void> {
  const chatId = ctx.chat!.id;
  const telegram = ctx.telegram;
  const status = await ctx.reply('⏳ جاري تنزيل الرابط...').catch(() => undefined);
  const statusId = status?.message_id;
  const removeStatus = () =>
    statusId ? telegram.deleteMessage(chatId, statusId).catch(() => undefined) : undefined;

  const job = async () => {
    try {
      if (statusId) await telegram.editMessageText(chatId, statusId, undefined, '⬇️ جاري التنزيل...').catch(() => undefined);
      await telegram.sendChatAction(chatId, 'upload_video').catch(() => undefined);

      const result = await downloadVideo(url);
      if ('error' in result) {
        // Non-media links posted casually shouldn't spam an error.
        if (result.error === 'unsupported' && opts.silentUnsupported) {
          await removeStatus();
          return;
        }
        const reason = result.reason ? `\n📄 ${result.reason}` : '';
        if (statusId) await telegram.editMessageText(chatId, statusId, undefined, ERRORS[result.error] + reason).catch(() => undefined);
        return;
      }

      try {
        const { size } = await stat(result.filePath);
        if (size > TELEGRAM_SEND_LIMIT) {
          if (statusId) await telegram.editMessageText(chatId, statusId, undefined, ERRORS.toolarge).catch(() => undefined);
          return;
        }
        const file = Input.fromLocalFile(result.filePath);
        if (result.isVideo) {
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
      if (statusId) await telegram.editMessageText(chatId, statusId, undefined, ERRORS.failed).catch(() => undefined);
    }
  };

  const position = youtubeQueue.enqueue(
    chatId,
    job,
    youtubeConfig.concurrentDownloadsPerGroup,
    youtubeConfig.maxQueuePerGroup,
  );
  if (position === -1 && statusId) {
    await telegram.editMessageText(chatId, statusId, undefined, '⚠️ قائمة الانتظار ممتلئة، حاول لاحقاً.').catch(() => undefined);
  }
}
