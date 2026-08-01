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
    { command: 'lang', description: '🌐 لغة الجروب: /lang ar|en', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('settings', requireRole('moderator'), async (ctx) => {
      const t = ctx.state.t!;
      const s = ctx.state.settings ?? (await getSettings(ctx.chat.id));
      if (!s) return;
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
      await ctx.reply(`${t('settings.header')}\n\n${lines.join('\n')}\n\n/set <key> on|off`);
    });

    // /set <key> <on|off>
    bot.command('set', requireRole('admin'), async (ctx) => {
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

    bot.command('setrules', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const rules = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!rules) return void ctx.reply(t('settings.rules_usage'));
      await setRules(ctx.chat.id, rules);
      await ctx.reply(t('settings.rules_set'));
    });

    bot.command('lang', requireRole('admin'), async (ctx) => {
      const lang = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (!lang || !isSupportedLocale(lang)) {
        await ctx.reply('🌐 استخدم: /lang ar  أو  /lang en');
        return;
      }
      await setLocale(ctx.chat.id, lang);
      await ctx.reply(lang === 'ar' ? '✅ تم ضبط اللغة إلى العربية.' : '✅ Language set to English.');
    });

    bot.command('setwelcome', requireRole('admin'), async (ctx) => {
      const msg = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!msg) {
        await ctx.reply('استخدم: /setwelcome نص الترحيب (يدعم {name} و {title})');
        return;
      }
      await prisma.chatSettings.update({
        where: { chatId: BigInt(ctx.chat.id) },
        data: { welcomeMessage: msg, welcomeEnabled: true },
      });
      await ctx.reply('✅ تم تحديث رسالة الترحيب.');
    });
  },
};
