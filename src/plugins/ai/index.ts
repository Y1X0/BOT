import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { askAi, canUseAi } from '../../services/ai.service';

async function runAi(ctx: BotContext, prompt: string): Promise<void> {
  const t = ctx.state.t!;
  if (!prompt) return void ctx.reply(t('ai.usage'));
  if (ctx.chat && !canUseAi(ctx.chat.id)) return void ctx.reply(t('ai.limit'));
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
}

function aiReady(ctx: BotContext): boolean {
  return Boolean(env.AI_ENABLED && env.AI_API_KEY && ctx.state.settings?.aiEnabled);
}

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
      if (!aiReady(ctx)) return void ctx.reply(ctx.state.t!('ai.disabled'));
      await runAi(ctx, ctx.message.text.split(' ').slice(1).join(' ').trim());
    });

    // Respond naturally when the bot is @mentioned or its message is replied to.
    bot.on(message('text'), async (ctx, next) => {
      if (!aiReady(ctx) || !ctx.from || ctx.from.is_bot) return next();
      const text = ctx.message.text;
      if (text.startsWith('/')) return next();

      const botUser = ctx.botInfo?.username;
      const repliedToBot =
        (ctx.message as { reply_to_message?: { from?: { id: number } } }).reply_to_message?.from?.id ===
        ctx.botInfo?.id;
      const mentioned = botUser ? new RegExp(`@${botUser}\\b`, 'i').test(text) : false;

      if (!repliedToBot && !mentioned) return next();

      const prompt = text.replace(new RegExp(`@${botUser}`, 'ig'), '').trim();
      if (!prompt) return next();
      await runAi(ctx, prompt);
      return; // consumed
    });
  },
};
