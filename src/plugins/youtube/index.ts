import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { stat } from 'node:fs/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { requireRole } from '../../utils/permissions';
import { search, downloadAudio, type SearchItem, type YtError } from '../../services/youtube/ytdlp';
import { youtubeQueue } from '../../services/youtube/queue';
import { youtubeConfig, setConfig, TELEGRAM_SEND_LIMIT, type YoutubeConfig } from '../../services/youtube/config';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:youtube');

// Search results kept briefly so a tapped number maps back to a video.
const resultCache = new Map<string, SearchItem[]>();
const MAX_CACHE = 500;

const ERRORS: Record<YtError, string> = {
  notinstalled: '⚠️ خدمة الصوت غير مهيّأة على الخادم بعد.',
  notfound: '❌ ما لقيت نتيجة، جرّب اسم أوضح.',
  toolarge: '❌ الملف تجاوز الحد المسموح.',
  blocked:
    '⚠️ يوتيوب حجب الطلب بعد تجربة عدة طرق.\nجرّب لاحقاً، أو (للمطوّر) أضف YT_COOKIES أو YT_PROXY لتجاوز الحجب.',
  failed: '⚠️ تعذّر جلب الصوت الآن، حاول مرة ثانية.',
  timeout: '⌛ انتهى وقت التحميل (الفيديو طويل جداً؟)، حاول مرة ثانية.',
};

function cacheResults(chatId: number, msgId: number, items: SearchItem[]): void {
  if (resultCache.size >= MAX_CACHE) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(`${chatId}:${msgId}`, items);
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return ` (${m}:${String(s).padStart(2, '0')})`;
}

export const youtubePlugin: Plugin = {
  name: 'youtube',
  description: 'YouTube audio: multi-result search, per-chat queue, live status',
  commands: [
    { command: 'yt', description: '🎵 بحث صوت: /yt اسم الأغنية' },
    { command: 'ytconfig', description: '⚙️ إعدادات اليوتيوب', staffOnly: true },
    { command: 'ytset', description: '🔧 تعديل حد يوتيوب', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- Search → show numbered results ---
    bot.command('yt', async (ctx) => {
      if (!env.YT_ENABLED) return void ctx.reply('🎵 خدمة الصوت غير مفعّلة.');
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) return void ctx.reply('🎵 اكتب اسم الأغنية.\nمثال: يوت باب الحارة');
      if (query.length > 150) return void ctx.reply('🎵 البحث طويل جداً.');

      const status = await ctx.reply(`🔎 جاري البحث عن: ${query} ...`);
      const found = await search(query, youtubeConfig.maxResults);

      if ('error' in found) {
        await editText(ctx, status.message_id, ERRORS[found.error]);
        return;
      }

      cacheResults(ctx.chat.id, status.message_id, found);
      const lines = found
        .map((it, i) => `${i + 1}. ${it.title}${fmtDuration(it.duration)}`)
        .join('\n');
      const buttons = found.map((_, i) =>
        Markup.button.callback(String(i + 1), `ytp:${status.message_id}:${i}`),
      );
      // 5 buttons per row.
      const rows: (typeof buttons)[] = [];
      for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));

      await editText(ctx, status.message_id, `🔎 نتائج «${query}»:\n\n${lines}\n\n👇 اضغط الرقم`, {
        reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => b)) },
      });
    });

    // --- Pick a result → enqueue a download job ---
    bot.action(/^ytp:(\d+):(\d+)$/, async (ctx) => {
      const chatId = ctx.chat!.id;
      const msgId = Number(ctx.match[1]);
      const index = Number(ctx.match[2]);
      const items = resultCache.get(`${chatId}:${msgId}`);
      const item = items?.[index];
      if (!item) {
        await ctx.answerCbQuery('انتهت صلاحية النتائج، ابحث من جديد.', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery(`تمت الإضافة: ${item.title.slice(0, 40)}`);

      const telegram = ctx.telegram;
      const status = await telegram
        .sendMessage(chatId, `⏳ في قائمة الانتظار: ${item.title}`)
        .catch(() => undefined);
      const statusId = status?.message_id;

      const job = async () => {
        try {
          if (statusId) await telegram.editMessageText(chatId, statusId, undefined, `⬇️ جاري التحميل: ${item.title}`).catch(() => undefined);
          await telegram.sendChatAction(chatId, 'upload_voice').catch(() => undefined);

          const result = await downloadAudio(item.videoId);
          if ('error' in result) {
            if (statusId) await telegram.editMessageText(chatId, statusId, undefined, ERRORS[result.error]).catch(() => undefined);
            return;
          }

          try {
            const { size } = await stat(result.filePath);
            if (size > TELEGRAM_SEND_LIMIT) {
              if (statusId)
                await telegram
                  .editMessageText(
                    chatId,
                    statusId,
                    undefined,
                    `❌ حجم الملف ${(size / 1024 / 1024).toFixed(1)}MB أكبر من حد تيليجرام للبوتات (50MB).\nلرفع الحد يلزم تشغيل Local Bot API.`,
                  )
                  .catch(() => undefined);
              return;
            }
            await telegram.sendAudio(
              chatId,
              Input.fromLocalFile(result.filePath),
              { title: result.title, performer: 'YouTube', caption: `🎵 ${result.title}` },
            );
            if (statusId) await telegram.deleteMessage(chatId, statusId).catch(() => undefined);
          } finally {
            await result.cleanup(); // always remove temp files
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
      if (position === -1) {
        if (statusId) await telegram.editMessageText(chatId, statusId, undefined, '⚠️ قائمة الانتظار ممتلئة، حاول لاحقاً.').catch(() => undefined);
      } else if (position > youtubeConfig.concurrentDownloadsPerGroup && statusId) {
        await telegram.editMessageText(chatId, statusId, undefined, `⏳ في قائمة الانتظار (ترتيبك: ${position}): ${item.title}`).catch(() => undefined);
      }
    });

    // --- Admin: view/adjust limits ---
    bot.command('ytconfig', requireRole('admin'), async (ctx) => {
      const c = youtubeConfig;
      await ctx.reply(
        '⚙️ إعدادات اليوتيوب:\n' +
          `• maxDuration: ${c.maxDuration ?? 'بدون حد'}${c.maxDuration ? ' ث' : ''}\n` +
          `• maxSize: ${c.maxSize ? (c.maxSize / 1024 / 1024).toFixed(0) + ' MB' : 'بدون حد'}\n` +
          `• maxResults: ${c.maxResults}\n` +
          `• concurrentDownloadsPerGroup: ${c.concurrentDownloadsPerGroup}\n\n` +
          'للتعديل: /ytset <المفتاح> <القيمة|off>\n' +
          'مثال: /ytset maxResults 15  •  /ytset maxDuration off',
      );
    });

    bot.command('ytset', requireRole('admin'), async (ctx) => {
      const [, key, raw] = ctx.message.text.split(/\s+/);
      const valid: Array<keyof YoutubeConfig> = [
        'maxDuration',
        'maxSize',
        'maxResults',
        'concurrentDownloadsPerGroup',
      ];
      if (!key || !raw || !valid.includes(key as keyof YoutubeConfig)) {
        await ctx.reply('🔧 استخدم: /ytset <maxDuration|maxSize|maxResults|concurrentDownloadsPerGroup> <رقم|off>');
        return;
      }
      let value: number | null;
      if (raw === 'off' || raw === 'none' || raw === 'null') value = null;
      else if (/^\d+$/.test(raw)) value = key === 'maxSize' ? Number(raw) * 1024 * 1024 : Number(raw);
      else return void ctx.reply('❌ القيمة غير صحيحة.');

      const ok = setConfig(key as keyof YoutubeConfig, value);
      await ctx.reply(ok ? `✅ تم ضبط ${key}.` : '❌ تعذّر الضبط (لا يمكن إلغاء هذا الحد).');
    });
  },
};

async function editText(
  ctx: BotContext,
  messageId: number,
  text: string,
  extra?: { reply_markup?: { inline_keyboard: unknown[][] } },
): Promise<void> {
  await ctx.telegram
    .editMessageText(ctx.chat!.id, messageId, undefined, text, extra as never)
    .catch(() => undefined);
}
