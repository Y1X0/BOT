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
import { to12h } from '../../utils/time';
import { AYAT, AHADITH, ATHKAR, TASBEEH_PHRASES, MORNING_ATHKAR, EVENING_ATHKAR } from './data';
import { slotForHour, slotTag, dailyAyahNumber, matchPrayer, type AthkarSlot } from './schedule';
import { dayKey } from '../social/logic';

const DEFAULT_PRAYER_CITY = 'Amman,Jordan';

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

interface Edition {
  text?: string;
  numberInSurah?: number;
  surah?: { name?: string };
  edition?: { identifier?: string };
}

/** Fetch a verse (Uthmani) + its simple tafsir (التفسير الميسّر) for verse #n. */
async function ayahWithTafsir(n: number): Promise<string | null> {
  const d = await getJson<{ data?: Edition[] }>(
    `https://api.alquran.cloud/v1/ayah/${n}/editions/quran-uthmani,ar.muyassar`,
  );
  const arr = d?.data;
  if (!arr?.length) return null;
  const q = arr.find((e) => e.edition?.identifier === 'quran-uthmani');
  const tafsir = arr.find((e) => e.edition?.identifier === 'ar.muyassar')?.text;
  if (!q?.text) return null;
  const ref = q.surah?.name ? `\n[${q.surah.name}: ${q.numberInSurah}]` : '';
  return `📖 آية اليوم\n\n﴿ ${q.text} ﴾${ref}${tafsir ? `\n\n📝 التفسير الميسّر:\n${tafsir}` : ''}`;
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
    { command: 'ayahtafsir', description: '📖 آية اليوم مع تفسير' },
    { command: 'athkarauto', description: '⚙️ تفعيل/إيقاف الأذكار التلقائية', staffOnly: true },
    { command: 'dailyayah', description: '⚙️ تفعيل/إيقاف آية اليوم التلقائية', staffOnly: true },
    { command: 'prayernotify', description: '🕌 تنبيه أوقات الصلاة: /prayernotify on Amman', staffOnly: true },
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
          `الفجر: ${to12h(t.Fajr)}\n` +
          `الشروق: ${to12h(t.Sunrise)}\n` +
          `الظهر: ${to12h(t.Dhuhr)}\n` +
          `العصر: ${to12h(t.Asr)}\n` +
          `المغرب: ${to12h(t.Maghrib)}\n` +
          `العشاء: ${to12h(t.Isha)}`,
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

    // Today's ayah + simple tafsir (same verse for everyone that day).
    bot.command('ayahtafsir', async (ctx) => {
      const msg = await ayahWithTafsir(dailyAyahNumber(new Date())).catch(() => null);
      await ctx.reply(msg ?? '❌ تعذّر جلب آية اليوم، حاول لاحقاً.');
    });

    bot.command('dailyayah', requireRole('manager'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const on = arg === 'on' || arg === 'تفعيل';
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف';
      if (!on && !off) {
        const cur = ctx.state.settings?.dailyAyahEnabled ? 'مفعّلة ✅' : 'متوقفة ❌';
        return void ctx.reply(`📖 آية اليوم التلقائية: ${cur}\nتُرسل يومياً ٩ص.\nاستخدم: /dailyayah on  أو  /dailyayah off`);
      }
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat.id) }, data: { dailyAyahEnabled: on } });
      await ctx.reply(on ? '📖 تم تفعيل آية اليوم التلقائية (٩ص).' : '📖 تم إيقاف آية اليوم التلقائية.');
    });

    // Toggle the automatic morning/evening athkar for this group.
    bot.command('athkarauto', requireRole('manager'), async (ctx) => {
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

    // Enable/disable prayer-time announcements (with optional city).
    bot.command('prayernotify', requireRole('manager'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const arg = parts[0]?.toLowerCase();
      const on = arg === 'on' || arg === 'تفعيل';
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف';
      if (!on && !off) {
        const s = ctx.state.settings;
        const cur = s?.prayerNotifyEnabled ? 'مفعّلة ✅' : 'متوقفة ❌';
        return void ctx.reply(`🕌 تنبيه أوقات الصلاة: ${cur}\nالمدينة: ${s?.prayerCity ?? DEFAULT_PRAYER_CITY}\nاستخدم: /prayernotify on عمّان   أو   /prayernotify off`);
      }
      const city = parts.slice(1).join(' ').trim() || undefined;
      await prisma.chatSettings.update({
        where: { chatId: BigInt(ctx.chat.id) },
        data: { prayerNotifyEnabled: on, ...(city ? { prayerCity: city } : {}) },
      });
      await ctx.reply(
        on
          ? `🕌 تم تفعيل تنبيه أوقات الصلاة لمدينة «${city ?? ctx.state.settings?.prayerCity ?? DEFAULT_PRAYER_CITY}». سيُعلن البوت عند دخول كل صلاة.`
          : '🕌 تم إيقاف تنبيه أوقات الصلاة.',
      );
    });

    // Hourly ticker → athkar (7/18) and the daily ayah (9) to enabled groups.
    const interval = setInterval(() => {
      void tickAthkar(bot);
      void tickDailyAyah(bot);
    }, 60 * 60 * 1000);
    interval.unref?.();

    // Enable prayer notifications on groups that predate this feature (once).
    void backfillPrayerDefault();

    // Per-minute ticker → announce each prayer at its exact time.
    const prayerInterval = setInterval(() => void tickPrayer(bot), 60 * 1000);
    prayerInterval.unref?.();

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

async function tickDailyAyah(bot: Telegraf<BotContext>): Promise<void> {
  try {
    if (hourInTz(env.DEFAULT_TIMEZONE) !== 9) return;
    const now = new Date();
    const tag = dayKey(now);
    const chats = await prisma.chat.findMany({
      where: { type: { in: ['group', 'supergroup'] }, settings: { dailyAyahEnabled: true } },
      include: { settings: true },
    });
    const pending = chats.filter((c) => c.settings?.lastDailyAyah !== tag);
    if (!pending.length) return;
    const msg = await ayahWithTafsir(dailyAyahNumber(now)); // one fetch, shared by all
    if (!msg) return;
    for (const chat of pending) {
      await bot.telegram.sendMessage(Number(chat.id), msg).catch(() => undefined);
      await prisma.chatSettings.update({ where: { chatId: chat.id }, data: { lastDailyAyah: tag } }).catch(() => undefined);
    }
  } catch (err) {
    log.warn({ err }, 'daily ayah tick failed');
  }
}

interface TimingsResponse {
  data?: { timings?: Record<string, string>; meta?: { timezone?: string } };
}
interface CachedTimings {
  day: string;
  timings: Record<string, string>;
  tz: string;
}
const timingsCache = new Map<string, CachedTimings>();

/** Today's prayer timings for a city (cached once per day per city). */
async function getTimings(city: string): Promise<CachedTimings | null> {
  const today = new Date().toISOString().slice(0, 10);
  const cached = timingsCache.get(city);
  if (cached && cached.day === today) return cached;
  const d = await getJson<TimingsResponse>(
    `https://api.aladhan.com/v1/timingsByAddress?address=${encodeURIComponent(city)}&method=4`,
  );
  const timings = d?.data?.timings;
  if (!timings) return null;
  const entry: CachedTimings = { day: today, timings, tz: d?.data?.meta?.timezone ?? env.DEFAULT_TIMEZONE };
  timingsCache.set(city, entry);
  return entry;
}

/** Current minutes-since-midnight in a timezone. */
function minutesInTz(tz: string): number {
  const hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date());
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 24) * 60 + m;
}

/** One-time: turn prayer notifications on for chats created before the feature. */
async function backfillPrayerDefault(): Promise<void> {
  try {
    const done = await prisma.appState.findUnique({ where: { key: 'prayerBackfill' } });
    if (done) return;
    const res = await prisma.chatSettings.updateMany({ where: { prayerNotifyEnabled: false }, data: { prayerNotifyEnabled: true } });
    await prisma.appState.create({ data: { key: 'prayerBackfill', value: String(res.count) } });
    log.info({ count: res.count }, 'prayer-notify backfill applied');
  } catch (err) {
    log.warn({ err }, 'prayer backfill failed');
  }
}

async function tickPrayer(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const chats = await prisma.chat.findMany({
      where: { type: { in: ['group', 'supergroup'] }, settings: { prayerNotifyEnabled: true } },
      include: { settings: true },
    });
    if (!chats.length) return;

    // Group chats by city to share one API call & timings per city.
    const byCity = new Map<string, typeof chats>();
    for (const c of chats) {
      const city = c.settings?.prayerCity || DEFAULT_PRAYER_CITY;
      (byCity.get(city) ?? byCity.set(city, []).get(city)!).push(c);
    }

    for (const [city, cityChats] of byCity) {
      const data = await getTimings(city);
      if (!data) continue;
      const prayer = matchPrayer(minutesInTz(data.tz), data.timings);
      if (!prayer) continue;
      const dayTz = new Intl.DateTimeFormat('en-CA', { timeZone: data.tz }).format(new Date()); // YYYY-MM-DD
      const tag = `${dayTz}:${prayer.key}`;
      const msg = `🕌 حان الآن موعد صلاة ${prayer.ar}\nحيّ على الصلاة 🤍`;
      for (const c of cityChats) {
        if (c.settings?.lastPrayerAnnounced === tag) continue;
        await bot.telegram.sendMessage(Number(c.id), msg).catch(() => undefined);
        await prisma.chatSettings.update({ where: { chatId: c.id }, data: { lastPrayerAnnounced: tag } }).catch(() => undefined);
      }
    }
  } catch (err) {
    log.warn({ err }, 'prayer tick failed');
  }
}

// Tiny deterministic-ish shuffle helper (Math.random is fine at runtime).
function positionSeed(): boolean {
  return Math.random() < 0.5;
}
