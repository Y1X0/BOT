import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { requireRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';
import { QUESTIONS } from './data';
import { questionIndex, isQotdDue } from './logic';

const log = createLogger('plugin:qotd');
const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

function questionFor(chatId: number, now: Date): string {
  return QUESTIONS[questionIndex(String(chatId), now, QUESTIONS.length)];
}

/** Question of the day: manual command + opt-in automatic daily posting. */
export const qotdPlugin: Plugin = {
  name: 'qotd',
  description: 'Question of the day (manual + auto)',
  commands: [
    { command: 'qotd', description: '💭 سؤال اليوم' },
    { command: 'qotdauto', description: '⚙️ تفعيل/إيقاف سؤال اليوم التلقائي', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('qotd', async (ctx) => {
      if (!isGroup(ctx)) return;
      await ctx.reply(`💭 سؤال اليوم:\n\n${questionFor(ctx.chat!.id, new Date())}`);
    });

    bot.command('qotdauto', requireRole('manager'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const on = arg === 'on' || arg === 'تفعيل';
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف';
      if (!on && !off) {
        const cur = ctx.state.settings?.qotdEnabled ? 'مفعّل ✅' : 'متوقف ❌';
        return void ctx.reply(`💭 سؤال اليوم التلقائي: ${cur}\nاستخدم: /qotdauto on  أو  /qotdauto off\n(يُنشر يومياً ١٠ص UTC)`);
      }
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat!.id) }, data: { qotdEnabled: on } });
      await ctx.reply(on ? '💭 تم تفعيل سؤال اليوم التلقائي.' : '💭 تم إيقاف سؤال اليوم التلقائي.');
    });

    const interval = setInterval(() => void tick(bot), 60 * 60 * 1000);
    interval.unref?.();
  },
};

async function tick(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const now = new Date();
    const chats = await prisma.chatSettings.findMany({ where: { qotdEnabled: true } });
    for (const c of chats) {
      if (!isQotdDue(now, c.lastQotdAt)) continue;
      await bot.telegram.sendMessage(Number(c.chatId), `💭 سؤال اليوم:\n\n${questionFor(Number(c.chatId), now)}`).catch(() => undefined);
      await prisma.chatSettings.update({ where: { chatId: c.chatId }, data: { lastQotdAt: now } });
    }
  } catch (err) {
    log.warn({ err }, 'qotd tick failed');
  }
}
