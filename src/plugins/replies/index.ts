import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import {
  addReply,
  deleteReply,
  listReplies,
  matchReply,
} from '../../services/replies.service';
import { pickRandom } from '../../utils/format';
import { matchSmartRule } from './smart-replies';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:replies');

/**
 * Interactive replies plugin:
 *  - Passive: reacts to keywords with custom (DB) or built-in smart replies.
 *  - Admin commands: /addreply, /delreply, /replies.
 * The passive listener is registered late so games/engagement run first; it
 * does not call next() (it is a terminal responder for matched keywords).
 */
export const repliesPlugin: Plugin = {
  name: 'replies',
  description: 'Smart & custom keyword replies with reactions',
  commands: [
    { command: 'addreply', description: '➕ إضافة رد مخصص (أدمن)', staffOnly: true },
    { command: 'delreply', description: '➖ حذف رد مخصص (أدمن)', staffOnly: true },
    { command: 'replies', description: '📋 عرض الردود المخصصة', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // /addreply trigger | response1 ; response2
    bot.command('addreply', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const raw = ctx.message.text.split(' ').slice(1).join(' ');
      const [trigger, responsesRaw] = raw.split('|').map((s) => s.trim());
      if (!trigger || !responsesRaw) {
        await ctx.reply(t('replies.add_usage'));
        return;
      }
      const responses = responsesRaw
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!responses.length) {
        await ctx.reply(t('replies.add_usage'));
        return;
      }
      await addReply(ctx.chat.id, trigger, responses, ctx.from.id);
      await ctx.reply(t('replies.added', { trigger }));
    });

    bot.command('delreply', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const trigger = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!trigger) {
        await ctx.reply(t('replies.del_usage'));
        return;
      }
      const ok = await deleteReply(ctx.chat.id, trigger);
      await ctx.reply(ok ? t('replies.deleted', { trigger }) : t('replies.notfound'));
    });

    bot.command('replies', requireRole('moderator'), async (ctx) => {
      const t = ctx.state.t!;
      const replies = await listReplies(ctx.chat.id);
      if (!replies.length) {
        await ctx.reply(t('replies.list_empty'));
        return;
      }
      const list = replies.map((r) => `• ${r.trigger}`).join('\n');
      await ctx.reply(t('replies.list_header', { list }));
    });

    // Passive keyword responder (terminal — no next()).
    bot.on(message('text'), async (ctx) => {
      const chat = ctx.chat;
      const settings = ctx.state.settings;
      const text = ctx.message.text;

      if (
        !chat ||
        (chat.type !== 'group' && chat.type !== 'supergroup') ||
        !settings?.repliesEnabled ||
        text.startsWith('/')
      ) {
        return;
      }

      // 1) Admin-defined custom replies take priority.
      const custom = await matchReply(chat.id, text);
      if (custom) {
        await ctx.reply(custom).catch(() => undefined);
        return;
      }

      // 2) Built-in smart replies.
      const rule = matchSmartRule(text);
      if (rule) {
        if (rule.reaction && settings.reactionsEnabled) {
          await safeReact(ctx, rule.reaction);
        }
        await ctx.reply(pickRandom(rule.responses)).catch(() => undefined);
      }
    });
  },
};

/** Add an emoji reaction, tolerating older Telegram/client limitations. */
async function safeReact(ctx: BotContext, emoji: string): Promise<void> {
  try {
    // Telegraf 4.16+ exposes ctx.react; fall back to raw API otherwise.
    const anyCtx = ctx as unknown as { react?: (e: string) => Promise<unknown> };
    if (typeof anyCtx.react === 'function') {
      await anyCtx.react(emoji);
    } else if (ctx.chat && ctx.message) {
      await ctx.telegram.callApi('setMessageReaction', {
        chat_id: ctx.chat.id,
        message_id: ctx.message.message_id,
        reaction: [{ type: 'emoji', emoji }],
      } as never);
    }
  } catch (err) {
    log.debug({ err }, 'Reaction failed (non-fatal)');
  }
}
