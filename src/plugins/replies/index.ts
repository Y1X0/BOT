import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import {
  addReply,
  addRichReply,
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
    { command: 'setreply', description: '✨ رد مميّز بإيموجي (بالرد على رسالة)', staffOnly: true },
    { command: 'delreply', description: '➖ حذف رد مخصص (أدمن)', staffOnly: true },
    { command: 'replies', description: '📋 عرض الردود المخصصة', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // /addreply trigger | response1 ; response2
    bot.command('addreply', requireRole('manager'), async (ctx) => {
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

    // /setreply <trigger> — used AS A REPLY to a message. Captures that
    // message's exact text + entities (premium/custom emoji, bold…) and stores
    // it as the reply for <trigger>. This is how a keyword gets a fancy reply.
    bot.command('setreply', requireRole('manager'), async (ctx) => {
      const trigger = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const replied = (ctx.message as {
        reply_to_message?: { text?: string; caption?: string; entities?: unknown[]; caption_entities?: unknown[] };
      }).reply_to_message;
      if (!trigger || !replied) {
        await ctx.reply('📌 الطريقة:\n1) ابعت رسالة فيها الكلمة والإيموجي المميّز اللي بدك ياه.\n2) ردّ عليها واكتب: رد مميز <الكلمة المحفّزة>\nمثال: ردّ على «أهلاً بكم 🎉» بـ «رد مميز هاي».');
        return;
      }
      const body = replied.text ?? replied.caption;
      const entities = (replied.entities ?? replied.caption_entities ?? []) as unknown[];
      if (!body) {
        await ctx.reply('⚠️ لازم ترد على رسالة نصية (تحتوي كلمات وإيموجي).');
        return;
      }
      await addRichReply(ctx.chat.id, trigger, body, entities, ctx.from.id);
      const hasPremium = entities.some((e) => (e as { type?: string }).type === 'custom_emoji');
      await ctx.reply(
        `✅ تم حفظ الرد المميّز للكلمة «${trigger}».` +
          (hasPremium ? '\n✨ فيه إيموجي مميّز — لازم مالك البوت عنده Telegram Premium حتى يبيّن متحرّك.' : ''),
      );
    });

    bot.command('delreply', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const trigger = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!trigger) {
        await ctx.reply(t('replies.del_usage'));
        return;
      }
      const ok = await deleteReply(ctx.chat.id, trigger);
      await ctx.reply(ok ? t('replies.deleted', { trigger }) : t('replies.notfound'));
    });

    bot.command('replies', requireRole('admin'), async (ctx) => {
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
        if (custom.entities?.length) {
          // Rich reply: re-send with entities so premium/custom emoji render.
          // If the bot owner lacks Premium, Telegram rejects it → fall back to plain.
          await ctx.reply(custom.text, { entities: custom.entities as never }).catch(async () => {
            await ctx.reply(custom.text).catch(() => undefined);
          });
        } else {
          await ctx.reply(custom.text).catch(() => undefined);
        }
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
