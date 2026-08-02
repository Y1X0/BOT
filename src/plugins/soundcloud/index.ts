import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { stat } from 'node:fs/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';
import { youtubeQueue } from '../../services/youtube/queue';
import { scSearch, scDownload, type ScItem } from '../../services/soundcloud';

const log = createLogger('plugin:soundcloud');
const TELEGRAM_SEND_LIMIT = 50 * 1024 * 1024; // ~50MB bot upload cap

const pending = new Map<string, ScItem[]>(); // `${chatId}:${msgId}` → results

const fmtDur = (s: number | null) => (s == null ? '' : ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`);

/** Song search & audio download from SoundCloud (a non-YouTube source). */
export const soundcloudPlugin: Plugin = {
  name: 'soundcloud',
  description: 'Search and download songs from SoundCloud',
  commands: [{ command: 'song', description: '🎵 ابحث عن أغنية: /song اسم الأغنية' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('song', async (ctx) => {
      if (!ctx.chat) return;
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) return void ctx.reply('🎵 اكتب اسم الأغنية:\n/song بابا الحاره   أو   اغنية اسم الأغنية');
      const status = await ctx.reply('🔎 جاري البحث في ساوندكلاود...');
      const res = await scSearch(query, 5);
      if ('error' in res) {
        const msg = res.error === 'notfound' ? '❌ ما لقيت نتائج، جرّب كلمات ثانية.' : res.error === 'notinstalled' ? '❌ أداة التنزيل غير مثبّتة.' : '⚠️ تعذّر البحث، حاول لاحقاً.';
        return void ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, msg).catch(() => undefined);
      }
      const rows = res.map((r, i) => [Markup.button.callback(`${i + 1}. ${r.title.slice(0, 45)}${fmtDur(r.duration)}`, `sc:${i}`)]);
      pending.set(`${ctx.chat.id}:${status.message_id}`, res);
      await ctx.telegram
        .editMessageText(ctx.chat.id, status.message_id, undefined, `🎵 اختر أغنية للتنزيل:`, Markup.inlineKeyboard(rows))
        .catch(() => undefined);
    });

    bot.action(/^sc:(\d+)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const list = pending.get(key);
      const item = list?.[Number(ctx.match[1])];
      if (!item) return void ctx.answerCbQuery('انتهت الصلاحية، أعد البحث.').catch(() => undefined);
      pending.delete(key);
      await ctx.answerCbQuery('⏳ جاري التنزيل...').catch(() => undefined);
      const chatId = ctx.chat!.id;
      const telegram = ctx.telegram;
      await ctx.editMessageText(`⏳ جاري تنزيل: ${item.title}`).catch(() => undefined);

      youtubeQueue.enqueue(
        chatId,
        async () => {
          const dl = await scDownload(item.url);
          if ('error' in dl) {
            await telegram.sendMessage(chatId, '⚠️ تعذّر تنزيل هذه الأغنية، جرّب وحدة ثانية.').catch(() => undefined);
            return;
          }
          try {
            const { size } = await stat(dl.filePath);
            if (size > TELEGRAM_SEND_LIMIT) {
              await telegram.sendMessage(chatId, '⚠️ الملف أكبر من الحد المسموح (50MB).').catch(() => undefined);
              return;
            }
            await telegram.sendAudio(chatId, Input.fromLocalFile(dl.filePath), { title: dl.title, caption: `🎵 ${dl.title}` });
            if (ctx.callbackQuery.message) await telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id).catch(() => undefined);
          } catch (err) {
            log.error({ err }, 'soundcloud send failed');
            await telegram.sendMessage(chatId, '⚠️ حدث خطأ أثناء الإرسال.').catch(() => undefined);
          } finally {
            await dl.cleanup();
          }
        },
        3,
        20,
      );
    });
  },
};
