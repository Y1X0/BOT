import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { pickRandom, displayName } from '../../utils/format';
import { addCoins } from '../../services/economy.service';
import { awardGameWin } from '../../utils/progression';

// Sentences to race on — no tricky punctuation so matching is fair.
const SENTENCES = [
  'العلم نور والجهل ظلام',
  'الوقت كالسيف إن لم تقطعه قطعك',
  'من جدّ وجد ومن زرع حصد',
  'الصديق وقت الضيق',
  'الكلمة الطيبة صدقة',
  'خير الناس أنفعهم للناس',
  'رأس الحكمة مخافة الله',
  'إذا تم العقل نقص الكلام',
  'الصبر مفتاح الفرج',
  'العقل السليم في الجسم السليم',
  'لا تؤجل عمل اليوم إلى الغد',
  'النظافة من الإيمان',
  'الطموح لا حدود له',
  'ابتسم فالحياة أجمل مع الابتسامة',
  'المعرفة قوة والقراءة غذاء العقل',
  'من سار على الدرب وصل',
  'الاتحاد قوة والتفرق ضعف',
  'كن أنت التغيير الذي تريد أن تراه',
];

interface Race {
  text: string;
  norm: string;
  startedAt: number;
}
const races = new Map<number, Race>();

// Normalize spacing only — the racer must type the words correctly, in order.
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Fast-typing race: first to retype the sentence exactly wins coins. */
export const typeRacePlugin: Plugin = {
  name: 'typerace',
  description: 'Fast typing race for coins',
  commands: [{ command: 'type', description: '⌨️ تحدي الكتابة السريعة' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('type', async (ctx) => {
      if (!isGroup(ctx)) return;
      if (races.has(ctx.chat!.id)) return void ctx.reply('⌨️ في تحدي شغّال حالياً! اكتب الجملة بسرعة ⚡');
      const text = pickRandom(SENTENCES);
      races.set(ctx.chat!.id, { text, norm: norm(text), startedAt: Date.now() });
      await ctx.reply(`⌨️ تحدي الكتابة السريعة!\nأول شخص يكتب الجملة بالضبط يفوز 🏆\n\n👇\n${text}`);
      // Auto-expire after 60s so a stale race never blocks the next one.
      setTimeout(() => {
        const r = races.get(ctx.chat!.id);
        if (r && r.text === text) {
          races.delete(ctx.chat!.id);
          ctx.reply('⏱️ انتهى وقت التحدي ولا أحد كتبها بالضبط!').catch(() => undefined);
        }
      }, 60_000).unref?.();
    });

    bot.on(message('text'), async (ctx, next) => {
      if (!isGroup(ctx)) return next();
      const race = races.get(ctx.chat!.id);
      if (!race) return next();
      const text = ctx.message.text;
      if (text.startsWith('/')) return next();
      if (norm(text) !== race.norm) return next(); // not a winning attempt — let others handle it

      races.delete(ctx.chat!.id);
      const secs = Math.max(1, Math.round((Date.now() - race.startedAt) / 1000));
      // Faster = more coins: 100 base minus 2 per second, floor 20, plus a bonus for <10s.
      const reward = Math.max(20, 100 - secs * 2) + (secs < 10 ? 30 : 0);
      if (ctx.from) {
        await addCoins(ctx.chat!.id, ctx.from.id, reward);
        await awardGameWin(ctx, 12);
      }
      await ctx
        .reply(`🏆 فاز ${displayName(ctx.from)} في ${secs} ثانية!\n💰 +${reward} عملة`)
        .catch(() => undefined);
      return; // consumed
    });
  },
};
