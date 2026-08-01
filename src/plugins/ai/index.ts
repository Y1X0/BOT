import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { askAi, canUseAi } from '../../services/ai.service';

/**
 * Optional AI assistant. Disabled globally unless AI_ENABLED=true AND the
 * chat has aiEnabled. Only responds when explicitly invoked via /ai, keeping
 * cost bounded (plus the per-chat daily limit in ai.service).
 */
export const aiPlugin: Plugin = {
  name: 'ai',
  description: 'On-demand AI assistant (opt-in, rate-limited)',
  commands: [{ command: 'ai', description: '🤖 اسأل المساعد الذكي' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('ai', async (ctx) => {
      const t = ctx.state.t!;

      if (!env.AI_ENABLED || !env.AI_API_KEY || !ctx.state.settings?.aiEnabled) {
        await ctx.reply(t('ai.disabled'));
        return;
      }

      const prompt = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!prompt) return void ctx.reply(t('ai.usage'));

      if (ctx.chat && !canUseAi(ctx.chat.id)) {
        await ctx.reply(t('ai.limit'));
        return;
      }

      const thinking = await ctx.reply(t('ai.thinking')).catch(() => undefined);
      const answer = ctx.chat ? await askAi(ctx.chat.id, prompt) : null;

      const text = answer ?? t('ai.error');
      if (thinking) {
        await ctx.telegram
          .editMessageText(ctx.chat!.id, thinking.message_id, undefined, text)
          .catch(() => ctx.reply(text));
      } else {
        await ctx.reply(text);
      }
    });
  },
};
