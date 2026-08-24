import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import {
  getSettings,
  setBoolean,
  setRules,
  setLocale,
  isToggleable,
  TOGGLEABLE_SETTINGS,
  type ToggleableSetting,
} from '../../services/settings.service';
import { isSupportedLocale } from '../../locales';
import { prisma } from '../../core/database';
import type { ChatSettings } from '@prisma/client';

/** Render the group's settings panel. Shared by /settings and the onboarding
 *  «⚙️ الإعدادات» button so the two never diverge. */
export function buildSettingsText(s: ChatSettings, t: (key: string) => string): string {
  const on = t('settings.on');
  const off = t('settings.off');
  const lines = TOGGLEABLE_SETTINGS.map(
    (key) => `${(s as Record<string, unknown>)[key] ? '🟢' : '🔴'} ${key}: ${(s as Record<string, unknown>)[key] ? on : off}`,
  );
  lines.push(
    '',
    `🔢 maxWarnings: ${s.maxWarnings}`,
    `⚙️ warnAction: ${s.warnAction}`,
    `🚦 floodLimit: ${s.floodLimit}/${s.floodWindowSec}s`,
  );
  return `${t('settings.header')}\n\n${lines.join('\n')}\n\n/set <key> on|off`;
}

/**
 * Admin control panel. `/settings` shows all toggles; `/set <key> <on|off>`
 * flips one; convenience aliases exist for the most common toggles.
 */
export const adminPlugin: Plugin = {
  name: 'admin',
  description: 'Group settings & configuration commands',
  commands: [
    { command: 'settings', description: '⚙️ عرض إعدادات الجروب', staffOnly: true },
    { command: 'set', description: '🔧 ضبط إعداد: /set key on|off', staffOnly: true },
    { command: 'setrules', description: '📜 تحديد قوانين الجروب', staffOnly: true },
    { command: 'setwelcome', description: '👋 تحديد رسالة الترحيب', staffOnly: true },
    { command: 'setwarns', description: '🔢 حد التحذيرات: /setwarns 3', staffOnly: true },
    { command: 'warnaction', description: '⚙️ عقوبة التحذيرات: /warnaction mute|kick|ban', staffOnly: true },
    { command: 'setflood', description: '🚦 ضبط التكرار: /setflood 7 10', staffOnly: true },
    { command: 'antiswear', description: '🚫 منع السب والشتم: /antiswear on|off', staffOnly: true },
    { command: 'lang', description: '🌐 لغة الجروب: /lang ar|en', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('settings', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const s = ctx.state.settings ?? (await getSettings(ctx.chat.id));
      if (!s) return;
      await ctx.reply(buildSettingsText(s, t));
    });

    // /set <key> <on|off>
    bot.command('set', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const [, key, value] = ctx.message.text.split(/\s+/);
      if (!key || !isToggleable(key)) {
        await ctx.reply(t('settings.unknown'));
        return;
      }
      const boolVal = value === 'on' || value === 'true' || value === '1';
      await setBoolean(ctx.chat.id, key as ToggleableSetting, boolVal);
      await ctx.reply(
        t('settings.toggled', { setting: key, value: boolVal ? t('settings.on') : t('settings.off') }),
      );
    });

    bot.command('setrules', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const rules = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!rules) return void ctx.reply(t('settings.rules_usage'));
      await setRules(ctx.chat.id, rules);
      await ctx.reply(t('settings.rules_set'));
    });

    bot.command('lang', requireRole('manager'), async (ctx) => {
      const lang = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (!lang || !isSupportedLocale(lang)) {
        await ctx.reply('🌐 استخدم: /lang ar  أو  /lang en');
        return;
      }
      await setLocale(ctx.chat.id, lang);
      await ctx.reply(lang === 'ar' ? '✅ تم ضبط اللغة إلى العربية.' : '✅ Language set to English.');
    });

    // 🔢 Set the warning limit before the escalation action fires.
    bot.command('setwarns', requireRole('manager'), async (ctx) => {
      const n = Number(ctx.message.text.split(/\s+/)[1]);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return void ctx.reply('🔢 استخدم رقماً بين 1 و 20. مثال: /setwarns 3');
      }
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat.id) }, data: { maxWarnings: n } });
      await ctx.reply(`✅ <b>تم ضبط حد التحذيرات إلى ${n}.</b>`);
    });

    // ⚙️ Set what happens when a member reaches the warning limit.
    bot.command('warnaction', requireRole('manager'), async (ctx) => {
      const action = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (action !== 'mute' && action !== 'kick' && action !== 'ban') {
        return void ctx.reply('⚙️ استخدم: /warnaction mute  أو  kick  أو  ban');
      }
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat.id) }, data: { warnAction: action } });
      const label = { mute: 'كتم 🔇', kick: 'طرد 👢', ban: 'حظر 🚫' }[action];
      await ctx.reply(`✅ عند بلوغ حد التحذيرات ستكون العقوبة: <b>${label}</b>.`);
    });

    // 🚦 Configure flood detection: max messages per window (seconds).
    bot.command('setflood', requireRole('manager'), async (ctx) => {
      const [, limitRaw, windowRaw] = ctx.message.text.split(/\s+/);
      const limit = Number(limitRaw);
      const windowSec = windowRaw === undefined ? 10 : Number(windowRaw);
      if (!Number.isInteger(limit) || limit < 3 || limit > 50 || !Number.isInteger(windowSec) || windowSec < 3 || windowSec > 60) {
        return void ctx.reply('🚦 <b>الاستخدام:</b> <code>/setflood [عدد 3-50] [ثواني 3-60]</code>\nمثال: <code>/setflood 7 10</code>');
      }
      await prisma.chatSettings.update({
        where: { chatId: BigInt(ctx.chat.id) },
        data: { floodLimit: limit, floodWindowSec: windowSec, floodEnabled: true },
      });
      await ctx.reply(`✅ <b>تم ضبط مكافحة التكرار:</b> ${limit} رسائل خلال ${windowSec} ثانية.`);
    });

    // 🚫 Toggle the built-in profanity/insult filter.
    bot.command('antiswear', requireRole('manager'), async (ctx) => {
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف' || arg === 'وقف';
      // No arg → just flip the current state (smart toggle).
      const cur = !!(ctx.state.settings as { badwordsEnabled?: boolean } | undefined)?.badwordsEnabled;
      const on = arg === 'on' || arg === 'تفعيل' || arg === 'فعل' ? true : off ? false : !cur;
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat.id) }, data: { badwordsEnabled: on } });
      await ctx.reply(
        on
          ? '🚫 تم تفعيل منع السب — سيُحذف أي سب أو شتم تلقائياً ويُحذَّر صاحبه.'
          : '✅ تم إيقاف منع السب.',
      );
    });

    bot.command('setwelcome', requireRole('manager'), async (ctx) => {
      const msg = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!msg) {
        await ctx.reply('📝 <b>الاستخدام:</b> <code>/setwelcome نص الترحيب</code>\n(يدعم {name} و {title})');
        return;
      }
      await prisma.chatSettings.update({
        where: { chatId: BigInt(ctx.chat.id) },
        data: { welcomeMessage: msg, welcomeEnabled: true },
      });
      await ctx.reply('✅ <b>تم تحديث رسالة الترحيب.</b>');
    });
  },
};
