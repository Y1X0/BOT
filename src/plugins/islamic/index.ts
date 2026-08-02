import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { prisma } from '../../core/database';
import { requireRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';
import { getJson } from '../../utils/http';
import { pickRandom } from '../../utils/format';
import { AYAT, AHADITH, ATHKAR, TASBEEH_PHRASES, MORNING_ATHKAR, EVENING_ATHKAR } from './data';
import { slotForHour, slotTag, type AthkarSlot } from './schedule';

const log = createLogger('plugin:islamic');

/** Local hour in the configured timezone (so 7am/6pm match the region). */
function hourInTz(tz: string): number {
  return (
    Number(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date())) % 24
  );
}

function athkarMessage(slot: AthkarSlot): string {
  const header = slot === 'm' ? '🌅 أذكار الصباح' : '🌇 أذكار المساء';
  const list = (slot === 'm' ? MORNING_ATHKAR : EVENING_ATHKAR).join('\n\n');
  return `${header}\n\n${list}\n\n🤍 تقبّل الله`;
}

/** Per-message tasbeeh counters. */
const tasbeehCounts = new Map<string, number>();

interface AladhanResponse {
  data?: { timings?: Record<string, string> };
}

interface AyahResponse {
  data?: { text?: string; numberInSurah?: number; surah?: { name?: string } };
}

/** Fetch a random ayah from the full Qur'an (6236 verses), accurate Uthmani text. */
async function randomAyah(): Promise<string | null> {
  const n = 1 + Math.floor(Math.random() * 6236);
  const d = await getJson<AyahResponse>(`https://api.alquran.cloud/v1/ayah/${n}/quran-uthmani`);
  const text = d?.data?.text;
  if (!text) return null;
  const surah = d.data?.surah?.name;
  const num = d.data?.numberInSurah;
  return `📖 ﴿ ${text} ﴾${surah ? `\n[${surah}: ${num}]` : ''}`;
}

export const islamicPlugin: Plugin = {
  name: 'islamic',
  description: 'Prayer times, ayah, hadith, athkar, tasbeeh counter',
  commands: [
    { command: 'prayer', description: '🕌 مواقيت الصلاة: /prayer المدينة' },
    { command: 'ayah', description: '📖 آية عشوائية' },
    { command: 'hadith', description: '🌹 حديث شريف' },
    { command: 'thikr', description: '📿 ذكر' },
    { command: 'athkar', description: '🤲 أذكار' },
    { command: 'sabah', description: '🌅 أذكار الصباح' },
    { command: 'masa', description: '🌇 أذكار المساء' },
    { command: 'tasbeeh', description: '📿 عدّاد التسبيح' },
    { command: 'athkarauto', description: '⚙️ تفعيل/إيقاف الأذكار التلقائية', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('prayer', async (ctx) => {
      const city = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!city) return void ctx.reply('🕌 اكتب اسم المدينة.\nمثال: /prayer الرياض  أو  صلاة الرياض');
      const data = await getJson<AladhanResponse>(
        `https://api.aladhan.com/v1/timingsByAddress?address=${encodeURIComponent(city)}&method=4`,
      );
      const t = data?.data?.timings;
      if (!t) return void ctx.reply('❌ تعذّر جلب المواقيت لهذه المدينة.');
      await ctx.reply(
        `🕌 مواقيت الصلاة — ${city}\n\n` +
          `الفجر: ${t.Fajr}\n` +
          `الشروق: ${t.Sunrise}\n` +
          `الظهر: ${t.Dhuhr}\n` +
          `العصر: ${t.Asr}\n` +
          `المغرب: ${t.Maghrib}\n` +
          `العشاء: ${t.Isha}`,
      );
    });

    bot.command('ayah', async (ctx) => {
      const ayah = (await randomAyah().catch(() => null)) ?? pickRandom(AYAT);
      await ctx.reply(ayah);
    });
    bot.command('hadith', async (ctx) => void ctx.reply(pickRandom(AHADITH)));
    bot.command('thikr', async (ctx) => void ctx.reply(pickRandom(ATHKAR)));
    bot.command('athkar', async (ctx) => {
      const set = [...ATHKAR].sort(() => (positionSeed() ? 1 : -1)).slice(0, 4).join('\n\n');
      await ctx.reply(`🤲 أذكار:\n\n${set}`);
    });

    bot.command('sabah', async (ctx) => void ctx.reply(athkarMessage('m')));
    bot.command('masa', async (ctx) => void ctx.reply(athkarMessage('e')));

    // Toggle the automatic morning/evening athkar for this group.
    bot.command('athkarauto', requireRole('admin'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const on = arg === 'on' || arg === 'تفعيل';
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف';
      if (!on && !off) {
        const cur = ctx.state.settings?.athkarEnabled ? 'مفعّلة ✅' : 'متوقفة ❌';
        return void ctx.reply(`🕌 الأذكار التلقائية: ${cur}\nتُرسل يومياً ٧ص و ٦م.\nاستخدم: /athkarauto on  أو  /athkarauto off`);
      }
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat.id) }, data: { athkarEnabled: on } });
      await ctx.reply(on ? '🕌 تم تفعيل الأذكار التلقائية (٧ص و ٦م).' : '🕌 تم إيقاف الأذكار التلقائية في هذا الجروب.');
    });

    // Hourly ticker → send morning (7) / evening (18) athkar to enabled groups.
    const interval = setInterval(() => void tickAthkar(bot), 60 * 60 * 1000);
    interval.unref?.();

    // Interactive tasbeeh counter.
    bot.command('tasbeeh', async (ctx) => {
      const phrase = TASBEEH_PHRASES[0];
      const sent = await ctx.reply(
        `📿 ${phrase}\nالعدد: 0`,
        Markup.inlineKeyboard([[Markup.button.callback('📿 سبّح (+1)', 'tsb'), Markup.button.callback('🔄 تصفير', 'tsb_reset')]]),
      );
      tasbeehCounts.set(`${ctx.chat.id}:${sent.message_id}`, 0);
    });

    bot.action('tsb', async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const n = (tasbeehCounts.get(key) ?? 0) + 1;
      tasbeehCounts.set(key, n);
      const phrase = TASBEEH_PHRASES[Math.floor(n / 33) % TASBEEH_PHRASES.length];
      await ctx.answerCbQuery(`${phrase} (${n})`).catch(() => undefined);
      await ctx
        .editMessageText(
          `📿 ${phrase}\nالعدد: ${n}${n % 33 === 0 ? '\n✅ أكملت 33!' : ''}`,
          Markup.inlineKeyboard([[Markup.button.callback('📿 سبّح (+1)', 'tsb'), Markup.button.callback('🔄 تصفير', 'tsb_reset')]]),
        )
        .catch(() => undefined);
    });

    bot.action('tsb_reset', async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      tasbeehCounts.set(key, 0);
      await ctx.answerCbQuery('تم التصفير').catch(() => undefined);
      await ctx
        .editMessageText(
          `📿 ${TASBEEH_PHRASES[0]}\nالعدد: 0`,
          Markup.inlineKeyboard([[Markup.button.callback('📿 سبّح (+1)', 'tsb'), Markup.button.callback('🔄 تصفير', 'tsb_reset')]]),
        )
        .catch(() => undefined);
    });
  },
};

async function tickAthkar(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const slot = slotForHour(hourInTz(env.DEFAULT_TIMEZONE));
    if (!slot) return;
    const tag = slotTag(new Date(), slot);
    const chats = await prisma.chat.findMany({
      where: { type: { in: ['group', 'supergroup'] }, settings: { athkarEnabled: true } },
      include: { settings: true },
    });
    const text = athkarMessage(slot);
    for (const chat of chats) {
      if (chat.settings?.lastAthkarSlot === tag) continue; // already sent this slot
      await bot.telegram.sendMessage(Number(chat.id), text).catch(() => undefined);
      await prisma.chatSettings.update({ where: { chatId: chat.id }, data: { lastAthkarSlot: tag } }).catch(() => undefined);
    }
  } catch (err) {
    log.warn({ err }, 'athkar tick failed');
  }
}

// Tiny deterministic-ish shuffle helper (Math.random is fine at runtime).
function positionSeed(): boolean {
  return Math.random() < 0.5;
}
