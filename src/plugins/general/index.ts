import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';

/**
 * Core /start and /help. Help is generated at call time from the registered
 * plugin command lists, so new plugins appear automatically.
 */
export function createGeneralPlugin(getPlugins: () => Plugin[]): Plugin {
  return {
    name: 'general',
    description: 'Start & help',
    commands: [
      { command: 'start', description: '🚀 بدء البوت' },
      { command: 'help', description: '❓ عرض الأوامر' },
    ],

    register(bot: Telegraf<BotContext>) {
      bot.start(async (ctx, next) => {
        // Deep-link payloads (e.g. whisper tokens) are handled by other
        // plugins' start handlers — pass through instead of showing the menu.
        if (ctx.startPayload) return next();
        const t = ctx.state.t!;
        await ctx.reply(t('start.private'));
      });

      bot.command('help', async (ctx) => {
        const t = ctx.state.t!;
        const isStaff = ctx.state.isStaff ?? false;
        const sections = getPlugins()
          .filter((p) => p.commands?.length)
          .map((p) => {
            const cmds = p.commands!.filter((c) => isStaff || !c.staffOnly);
            if (!cmds.length) return null;
            const lines = cmds.map((c) => `/${c.command} — ${c.description}`).join('\n');
            return `*${p.name}*\n${lines}`;
          })
          .filter(Boolean);

        await ctx.reply(`${t('help.header')}\n\n${sections.join('\n\n')}`);
      });
    },
  };
}
