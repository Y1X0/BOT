import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { getJson } from '../../utils/http';
import { displayName } from '../../utils/format';

const CRYPTO_MAP: Record<string, string> = {
  بيتكوين: 'bitcoin',
  بتكوين: 'bitcoin',
  bitcoin: 'bitcoin',
  btc: 'bitcoin',
  ايثيريوم: 'ethereum',
  ethereum: 'ethereum',
  eth: 'ethereum',
  ريبل: 'ripple',
  xrp: 'ripple',
  دوجكوين: 'dogecoin',
  doge: 'dogecoin',
  سولانا: 'solana',
  solana: 'solana',
  تيثر: 'tether',
  usdt: 'tether',
};

/** Pending reminders — in-memory (ephemeral). Bounded to avoid abuse. */
let pendingReminders = 0;
const MAX_REMINDERS = 200;

export const toolboxPlugin: Plugin = {
  name: 'toolbox',
  description: 'Translate, QR codes, currency/crypto prices, reminders',
  commands: [
    { command: 'tr', description: '🌐 ترجمة: /tr النص' },
    { command: 'qr', description: '📱 توليد QR: /qr النص' },
    { command: 'currency', description: '💵 أسعار العملات (الدولar)' },
    { command: 'crypto', description: '🪙 سعر عملة رقمية: /crypto bitcoin' },
    { command: 'remind', description: '⏰ تذكير: /remind 10m النص' },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- Translate (auto AR<->EN) ---
    bot.command('tr', async (ctx) => {
      const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!text) return void ctx.reply('🌐 اكتب النص بعد الأمر.\nمثال: /tr hello  أو  ترجم مرحبا');
      const target = /[؀-ۿ]/.test(text) ? 'en' : 'ar';
      const out = await translate(text, target);
      await ctx.reply(out ? `🌐 ${out}` : '❌ تعذّرت الترجمة الآن.');
    });

    // --- QR code ---
    bot.command('qr', async (ctx) => {
      const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!text) return void ctx.reply('📱 اكتب النص/الرابط بعد الأمر.\nمثال: /qr https://example.com');
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(text)}`;
      await ctx.replyWithPhoto(url, { caption: '📱 رمز QR' }).catch(() => ctx.reply('❌ تعذّر توليد الرمز.'));
    });

    // --- Currency (USD base) ---
    bot.command('currency', async (ctx) => {
      const data = await getJson<{ rates?: Record<string, number> }>('https://open.er-api.com/v6/latest/USD');
      const r = data?.rates;
      if (!r) return void ctx.reply('❌ تعذّر جلب الأسعار الآن.');
      await ctx.reply(
        '💵 أسعار الدولار (1 USD):\n\n' +
          `🇸🇦 ريال سعودي: ${fmt(r.SAR)}\n` +
          `🇦🇪 درهم إماراتي: ${fmt(r.AED)}\n` +
          `🇪🇬 جنيه مصري: ${fmt(r.EGP)}\n` +
          `🇰🇼 دينار كويتي: ${fmt(r.KWD)}\n` +
          `🇪🇺 يورو: ${fmt(r.EUR)}\n` +
          `🇬🇧 جنيه إسترليني: ${fmt(r.GBP)}\n` +
          `🇹🇷 ليرة تركية: ${fmt(r.TRY)}`,
      );
    });

    // --- Crypto price ---
    bot.command('crypto', async (ctx) => {
      const q = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
      const id = CRYPTO_MAP[q] ?? (q || 'bitcoin');
      const data = await getJson<Record<string, { usd?: number }>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`,
      );
      const price = data?.[id]?.usd;
      if (price == null) return void ctx.reply('❌ لم أجد هذه العملة. جرّب: /crypto bitcoin');
      await ctx.reply(`🪙 ${id.toUpperCase()}\nالسعر: $${price.toLocaleString('en-US')}`);
    });

    // --- Reminder ---
    bot.command('remind', async (ctx) => {
      if (!ctx.from) return;
      let raw = ctx.message.text.split(' ').slice(1).join(' ').trim();
      raw = raw.replace(/^بعد\s+/, '');
      const parsed = parseReminder(raw);
      if (!parsed) {
        await ctx.reply('⏰ استخدم: /remind 10m النص\nأو: ذكرني بعد 10 دقائق النص');
        return;
      }
      if (parsed.ms > 24 * 60 * 60 * 1000) return void ctx.reply('⏰ الحد الأقصى 24 ساعة.');
      if (pendingReminders >= MAX_REMINDERS) return void ctx.reply('⏰ عدد التذكيرات ممتلئ، حاول لاحقاً.');

      const { chat, from } = ctx;
      const chatId = chat!.id;
      const userId = from.id;
      const name = displayName(from);
      const note = parsed.text || 'تذكير';
      pendingReminders++;
      const timer = setTimeout(async () => {
        pendingReminders--;
        await ctx.telegram
          .sendMessage(chatId, `⏰ تذكير <a href="tg://user?id=${userId}">${escapeHtml(name)}</a>:\n${escapeHtml(note)}`, {
            parse_mode: 'HTML',
          })
          .catch(() => undefined);
      }, parsed.ms);
      timer.unref?.();
      await ctx.reply(`✅ تم ضبط التذكير بعد ${parsed.label}.`);
    });
  },
};

async function translate(text: string, target: string): Promise<string | null> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const data = await getJson<[Array<[string]>]>(url);
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return data[0].map((seg) => seg[0]).join('');
}

interface ParsedReminder {
  ms: number;
  text: string;
  label: string;
}
function parseReminder(raw: string): ParsedReminder | null {
  const m = raw.match(
    /^(\d+)\s*(ثانية|ثواني|ث|s|sec|seconds?|دقيقة|دقائق|دق|د|m|min|minutes?|ساعة|ساعات|س|h|hr|hours?)?\s*(.*)$/i,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const text = m[3]?.trim() ?? '';
  let ms: number;
  let label: string;
  if (/^(ثانية|ثواني|ث|s|sec|seconds?)$/i.test(unit)) {
    ms = n * 1000;
    label = `${n} ثانية`;
  } else if (/^(ساعة|ساعات|س|h|hr|hours?)$/i.test(unit)) {
    ms = n * 3600_000;
    label = `${n} ساعة`;
  } else {
    ms = n * 60_000;
    label = `${n} دقيقة`;
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { ms, text, label };
}

function fmt(v?: number): string {
  return v == null ? '—' : v.toFixed(2);
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
