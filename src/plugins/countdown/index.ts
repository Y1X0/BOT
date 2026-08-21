import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';
import { addEvent, listEvents, deleteEvent, dueToday, markAnnounced } from '../../services/countdown.service';
import { parseDate, daysRemaining, countdownLabel } from './logic';

const log = createLogger('plugin:countdown');
const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Countdown events: set a date, the bot counts down and announces on the day. */
export const countdownPlugin: Plugin = {
  name: 'countdown',
  description: 'Countdown to group events with an on-the-day announcement',
  commands: [
    { command: 'countdown', description: '⏳ أضف مناسبة: /countdown 2026-12-31 رأس السنة', staffOnly: true },
    { command: 'events', description: '📅 المناسبات القادمة' },
    { command: 'delevent', description: '🗑 احذف مناسبة: /delevent 3', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('countdown', requireRole('manager'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const target = parseDate(parts[0] ?? '');
      const name = parts.slice(1).join(' ').trim();
      if (!target || !name) return void ctx.reply('⏳ استخدم: /countdown 2026-12-31 اسم المناسبة');
      const days = daysRemaining(target, new Date());
      if (days < 0) return void ctx.reply('❌ التاريخ في الماضي.');
      const ev = await addEvent(ctx.chat!.id, name, target);
      await ctx.reply(`⏳ تمت إضافة «${name}» (#${ev.id})\n${countdownLabel(days)}`);
    });

    bot.command('events', async (ctx) => {
      if (!isGroup(ctx)) return;
      const now = new Date();
      const rows = await listEvents(ctx.chat!.id, now);
      if (!rows.length) return void ctx.reply('📅 لا مناسبات قادمة. أضف بـ /countdown 2026-12-31 اسم');
      const list = rows.map((e) => `#${e.id} — ${e.name}: ${countdownLabel(daysRemaining(e.targetAt, now))}`).join('\n');
      await ctx.reply(`📅 المناسبات القادمة:\n${list}`);
    });

    bot.command('delevent', requireRole('manager'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const id = Number(ctx.message.text.split(/\s+/)[1]);
      if (!Number.isInteger(id)) return void ctx.reply('🗑 استخدم: /delevent 3');
      const ok = await deleteEvent(id, ctx.chat!.id);
      await ctx.reply(ok ? `🗑 تم حذف المناسبة #${id}.` : '❌ لا توجد مناسبة بهذا الرقم.');
    });

    const interval = setInterval(() => void tick(bot), 60 * 60 * 1000);
    interval.unref?.();
  },
};

async function tick(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const now = new Date();
    if (now.getUTCHours() !== 9) return; // announce once, mornings UTC
    for (const ev of await dueToday(now)) {
      await bot.telegram.sendMessage(Number(ev.chatId), `🎉 اليوم: ${ev.name}! 🥳`).catch(() => undefined);
      await markAnnounced(ev.id);
    }
  } catch (err) {
    log.warn({ err }, 'countdown tick failed');
  }
}
