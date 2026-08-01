import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { setAfk, clearAfk, getAfk, getAfkByUsername, afkDuration } from '../../services/afk.service';
import { displayName } from '../../utils/format';

/**
 * AFK ("away from keyboard") system. A user marks themselves away; when they
 * next speak the bot welcomes them back, and if others mention/reply to them
 * while away, the bot notes that they're AFK.
 */
export const afkPlugin: Plugin = {
  name: 'afk',
  description: 'Away-from-keyboard status with mention notifications',
  commands: [{ command: 'afk', description: '💤 تعيين حالة غياب: /afk [السبب]' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('afk', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const reason = ctx.message.text.split(' ').slice(1).join(' ').trim() || null;
      await setAfk(ctx.chat.id, ctx.from, reason);
      await ctx.reply(
        `💤 ${displayName(ctx.from)} صار غائب الآن${reason ? `\nالسبب: ${reason}` : ''}.`,
      );
    });

    // Passive: handle return-from-AFK and mention/reply notifications.
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      const from = ctx.from;
      const text = ctx.message.text;
      if (
        !chat ||
        (chat.type !== 'group' && chat.type !== 'supergroup') ||
        !from ||
        from.is_bot
      ) {
        return next();
      }

      // 1) Sender returns from AFK (ignore the /afk command itself).
      if (!text.startsWith('/afk')) {
        const selfAfk = await getAfk(chat.id, from.id);
        if (selfAfk?.afkSince) {
          await clearAfk(chat.id, from.id);
          await ctx
            .reply(`👋 مرحباً بعودتك ${displayName(from)}! كنت غائباً منذ ${afkDuration(selfAfk.afkSince)}.`)
            .catch(() => undefined);
        }
      }

      // 2) Notify if this message targets an AFK user (reply or @mention).
      const notified = new Set<string>();

      const repliedTo = (ctx.message as { reply_to_message?: { from?: { id: number } } })
        .reply_to_message?.from;
      if (repliedTo && repliedTo.id !== from.id) {
        const afk = await getAfk(chat.id, repliedTo.id);
        if (afk?.afkSince && !notified.has(String(repliedTo.id))) {
          notified.add(String(repliedTo.id));
          await announceAfk(ctx, afk.firstName ?? 'العضو', afk.afkReason, afk.afkSince);
        }
      }

      for (const username of extractMentions(text)) {
        const afk = await getAfkByUsername(chat.id, username);
        if (afk?.afkSince && !notified.has(String(afk.userId))) {
          notified.add(String(afk.userId));
          await announceAfk(ctx, afk.firstName ?? `@${username}`, afk.afkReason, afk.afkSince);
        }
      }

      return next();
    });
  },
};

async function announceAfk(
  ctx: BotContext,
  name: string,
  reason: string | null,
  since: Date,
): Promise<void> {
  await ctx
    .reply(`💤 ${name} غائب حالياً (منذ ${afkDuration(since)})${reason ? `\nالسبب: ${reason}` : ''}.`)
    .catch(() => undefined);
}

function extractMentions(text: string): string[] {
  const matches = text.match(/@[A-Za-z0-9_]{3,}/g) ?? [];
  return matches.map((m) => m.slice(1));
}
