import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { requireRole } from '../../utils/permissions';
import {
  addScheduled,
  listScheduled,
  deleteScheduled,
  getDue,
  markSent,
  normalizeTime,
} from '../../services/scheduled.service';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:scheduled');

export const scheduledPlugin: Plugin = {
  name: 'scheduled',
  description: 'Daily scheduled messages',
  commands: [
    { command: 'schedule', description: '📅 جدولة رسالة يومية: /schedule 08:00 النص', staffOnly: true },
    { command: 'schedules', description: '🗒 قائمة الرسائل المجدولة', staffOnly: true },
    { command: 'unschedule', description: '🗑 حذف رسالة مجدولة: /unschedule 3', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('schedule', requireRole('admin'), async (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const time = normalizeTime(parts[1] ?? '');
      const text = parts.slice(2).join(' ').trim();
      if (!time || !text) {
        await ctx.reply('📅 استخدم: /schedule 08:00 صباح الخير يا شباب');
        return;
      }
      const row = await addScheduled(ctx.chat.id, time, text, ctx.from.id);
      await ctx.reply(`✅ تمت الجدولة يومياً الساعة ${time}. (رقم #${row.id})`);
    });

    bot.command('schedules', requireRole('moderator'), async (ctx) => {
      const rows = await listScheduled(ctx.chat.id);
      if (!rows.length) return void ctx.reply('🗒 لا توجد رسائل مجدولة.');
      const list = rows
        .map((r) => `#${r.id} • ${r.time} ${r.enabled ? '' : '(معطّل)'} — ${r.text.slice(0, 40)}`)
        .join('\n');
      await ctx.reply(`🗒 المجدولة:\n${list}\n\nللحذف: /unschedule <الرقم>`);
    });

    bot.command('unschedule', requireRole('admin'), async (ctx) => {
      const id = Number(ctx.message.text.split(/\s+/)[1]);
      if (!Number.isInteger(id)) return void ctx.reply('🗑 استخدم: /unschedule 3');
      const ok = await deleteScheduled(ctx.chat.id, id);
      await ctx.reply(ok ? '🗑 تم الحذف.' : '❌ لا يوجد بهذا الرقم.');
    });

    // Ticker: every minute, fire any messages due at the current HH:MM.
    const interval = setInterval(() => void tick(bot), 60_000);
    interval.unref?.();
  },
};

async function tick(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const now = new Date();
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: env.DEFAULT_TIMEZONE,
    }).format(now);
    const day = now.toISOString().slice(0, 10);
    const due = await getDue(time, day);
    for (const msg of due) {
      await bot.telegram.sendMessage(Number(msg.chatId), msg.text).catch(() => undefined);
      await markSent(msg.id, day);
    }
  } catch (err) {
    log.warn({ err }, 'scheduled tick failed');
  }
}
