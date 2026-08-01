import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { getText } from '../../utils/http';

/** Unit conversion factors to a base unit per dimension. */
const UNITS: Record<string, { base: string; factor: number }> = {
  // length → meter
  km: { base: 'm', factor: 1000 }, m: { base: 'm', factor: 1 }, cm: { base: 'm', factor: 0.01 },
  mm: { base: 'm', factor: 0.001 }, mile: { base: 'm', factor: 1609.34 }, ft: { base: 'm', factor: 0.3048 },
  // weight → gram
  kg: { base: 'g', factor: 1000 }, g: { base: 'g', factor: 1 }, mg: { base: 'g', factor: 0.001 },
  lb: { base: 'g', factor: 453.592 }, oz: { base: 'g', factor: 28.3495 },
};

export const utilitiesPlugin: Plugin = {
  name: 'utilities',
  description: 'Calculator, unit converter, password, hijri date, URL shortener',
  commands: [
    { command: 'calc', description: '🧮 آلة حاسبة: /calc 2+2*3' },
    { command: 'convert', description: '📏 تحويل وحدات: /convert 5 km m' },
    { command: 'password', description: '🔑 توليد كلمة سر: /password 16' },
    { command: 'hijri', description: '🌙 التاريخ الهجري' },
    { command: 'short', description: '🔗 اختصار رابط: /short الرابط' },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- Calculator (safe: only arithmetic characters allowed) ---
    bot.command('calc', async (ctx) => {
      const expr = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!expr) return void ctx.reply('🧮 اكتب المسألة.\nمثال: /calc (2+3)*4');
      if (!/^[0-9+\-*/%.()\s]+$/.test(expr)) return void ctx.reply('❌ رموز غير مسموحة. استخدم أرقام و + - * / ( ) فقط.');
      try {
        // Restricted input already validated to arithmetic-only.
        const result = Function(`"use strict"; return (${expr})`)();
        if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('bad');
        await ctx.reply(`🧮 ${expr} = ${result}`);
      } catch {
        await ctx.reply('❌ مسألة غير صحيحة.');
      }
    });

    // --- Unit converter ---
    bot.command('convert', async (ctx) => {
      const [, valueRaw, from, to] = ctx.message.text.split(/\s+/);
      const value = Number(valueRaw);
      if (!Number.isFinite(value) || !from || !to) {
        return void ctx.reply('📏 استخدم: /convert 5 km m\nأو حرارة: /convert 100 c f');
      }
      // Temperature special-case.
      const temp = convertTemp(value, from.toLowerCase(), to.toLowerCase());
      if (temp !== null) return void ctx.reply(`📏 ${value}°${from.toUpperCase()} = ${round(temp)}°${to.toUpperCase()}`);

      const a = UNITS[from.toLowerCase()];
      const b = UNITS[to.toLowerCase()];
      if (!a || !b || a.base !== b.base) return void ctx.reply('❌ وحدات غير مدعومة أو غير متوافقة.');
      const result = (value * a.factor) / b.factor;
      await ctx.reply(`📏 ${value} ${from} = ${round(result)} ${to}`);
    });

    // --- Password generator ---
    bot.command('password', async (ctx) => {
      const len = Math.min(Math.max(parseInt(ctx.message.text.split(/\s+/)[1] ?? '16', 10) || 16, 6), 64);
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
      let pw = '';
      for (let i = 0; i < len; i++) pw += chars[Math.floor(Math.random() * chars.length)];
      await ctx.reply(`🔑 كلمة سر (${len}):\n<code>${pw}</code>`, { parse_mode: 'HTML' });
    });

    // --- Hijri date ---
    bot.command('hijri', async (ctx) => {
      const hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { dateStyle: 'full' }).format(new Date());
      const greg = new Intl.DateTimeFormat('ar', { dateStyle: 'full' }).format(new Date());
      await ctx.reply(`🌙 التاريخ الهجري:\n${hijri}\n\n📅 الميلادي:\n${greg}`);
    });

    // --- URL shortener (is.gd) ---
    bot.command('short', async (ctx) => {
      const url = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!/^https?:\/\//i.test(url)) return void ctx.reply('🔗 أرسل رابطاً صحيحاً.\nمثال: /short https://example.com/long');
      const short = await getText(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`);
      if (!short || !short.startsWith('http')) return void ctx.reply('❌ تعذّر اختصار الرابط.');
      await ctx.reply(`🔗 ${short.trim()}`);
    });
  },
};

function convertTemp(v: number, from: string, to: string): number | null {
  const temps = ['c', 'f', 'k'];
  if (!temps.includes(from) || !temps.includes(to)) return null;
  let celsius = v;
  if (from === 'f') celsius = ((v - 32) * 5) / 9;
  else if (from === 'k') celsius = v - 273.15;
  if (to === 'c') return celsius;
  if (to === 'f') return (celsius * 9) / 5 + 32;
  return celsius + 273.15;
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
