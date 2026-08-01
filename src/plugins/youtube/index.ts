import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { downloadAudio, type YtError } from '../../services/youtube.service';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:youtube');

// One active download per chat + a per-user cooldown to bound cost/abuse.
const activeChats = new Set<number>();
const cooldowns = new Map<number, number>();

const ERROR_MESSAGES: Record<YtError, string> = {
  notinstalled: '⚠️ خدمة الصوت غير مهيّأة على الخادم بعد.',
  notfound: '❌ ما لقيت نتيجة مناسبة، جرّب اسم أوضح.',
  toolarge: '❌ الملف كبير جداً (الحد 50 ميجا). جرّب مقطع أقصر.',
  blocked: '⚠️ يوتيوب رفض الطلب من الخادم مؤقتاً، جرّب لاحقاً.',
  failed: '⚠️ تعذّر جلب الصوت الآن، حاول مرة ثانية.',
};

export const youtubePlugin: Plugin = {
  name: 'youtube',
  description: 'Search YouTube and send the audio (يوت / /yt)',
  commands: [{ command: 'yt', description: '🎵 بحث وإرسال صوت: /yt اسم الأغنية' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('yt', async (ctx) => {
      if (!env.YT_ENABLED) {
        await ctx.reply('🎵 خدمة الصوت غير مفعّلة.');
        return;
      }
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) {
        await ctx.reply('🎵 اكتب اسم الأغنية أو الصوت.\nمثال: يوت باب الحارة');
        return;
      }
      if (query.length > 100) {
        await ctx.reply('🎵 البحث طويل جداً، اختصره.');
        return;
      }

      const chatId = ctx.chat!.id;
      const userId = ctx.from!.id;

      // Per-user cooldown.
      const now = Date.now();
      const until = cooldowns.get(userId) ?? 0;
      if (now < until) {
        await ctx.reply(`⏳ انتظر ${Math.ceil((until - now) / 1000)} ثانية قبل طلب صوت آخر.`);
        return;
      }
      // One download at a time per chat.
      if (activeChats.has(chatId)) {
        await ctx.reply('⏳ يوجد تحميل جارٍ بالفعل، انتظر حتى ينتهي.');
        return;
      }

      activeChats.add(chatId);
      cooldowns.set(userId, now + env.YT_COOLDOWN_SEC * 1000);

      const status = await ctx
        .reply(`🔎 جاري البحث عن: ${query} ...`)
        .catch(() => undefined);

      try {
        await ctx.sendChatAction('upload_voice').catch(() => undefined);
        const result = await downloadAudio(query);

        if (!result.ok) {
          await ctx.reply(ERROR_MESSAGES[result.error]);
          return;
        }

        try {
          await ctx.replyWithAudio(Input.fromLocalFile(result.filePath), {
            title: result.title,
            performer: 'YouTube',
            caption: `🎵 ${result.title}`,
          });
        } finally {
          await result.cleanup();
        }
      } catch (err) {
        log.error({ err }, 'Failed to send audio');
        await ctx.reply(ERROR_MESSAGES.failed).catch(() => undefined);
      } finally {
        activeChats.delete(chatId);
        if (status) {
          await ctx.telegram.deleteMessage(chatId, status.message_id).catch(() => undefined);
        }
      }
    });
  },
};
