import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mention = (u: { id: number; first_name?: string; username?: string }): string =>
  `<a href="tg://user?id=${u.id}">${escapeHtml(displayName(u))}</a>`;

/**
 * Voice-chat interaction. Bots cannot start/stop group calls via the Bot API,
 * but they DO receive service messages when a voice chat starts/ends/etc — so
 * the bot announces those events to keep the group engaged.
 */
export const voiceChatPlugin: Plugin = {
  name: 'voicechat',
  description: 'Announce voice-chat start/end/scheduled events',

  register(bot: Telegraf<BotContext>) {
    bot.on(message('video_chat_started'), async (ctx) => {
      await ctx
        .reply('🎙 بدأت المكالمة الصوتية!\nانضموا وخلونا نسمع أصواتكم 🎧✨')
        .catch(() => undefined);
    });

    bot.on(message('video_chat_ended'), async (ctx) => {
      const seconds = ctx.message.video_chat_ended.duration;
      await ctx
        .reply(`📞 انتهت المكالمة الصوتية.\nالمدة: ${formatDuration(seconds)} — يعطيكم العافية 🌷`)
        .catch(() => undefined);
    });

    bot.on(message('video_chat_scheduled'), async (ctx) => {
      const at = ctx.message.video_chat_scheduled.start_date;
      const when = new Intl.DateTimeFormat('ar-SA', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Riyadh',
      }).format(new Date(at * 1000));
      await ctx.reply(`🗓 تم جدولة مكالمة صوتية.\nالموعد: ${when} — لا تفوّتونها! 🎙`).catch(() => undefined);
    });

    bot.on(message('video_chat_participants_invited'), async (ctx) => {
      const users = ctx.message.video_chat_participants_invited.users ?? [];
      if (!users.length) return;
      const names = users.map(mention).join('، ');
      await ctx
        .reply(`👥 تمت دعوة ${names} للمكالمة الصوتية 🎧\nيلا انضموا! 🎙`, { parse_mode: 'HTML' })
        .catch(() => undefined);
    });
  },
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} ثانية`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} دقيقة`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} ساعة و${rem} دقيقة` : `${h} ساعة`;
}
