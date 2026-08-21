import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { logAction } from '../../services/moderation.service';

const MAX_PURGE = 100;

/**
 * Group utility tools: polls plus common admin housekeeping commands
 * (pin, delete, purge, lock/unlock) and a member /report to admins.
 */
export const toolsPlugin: Plugin = {
  name: 'tools',
  description: 'Polls, pin/unpin, delete/purge, lock/unlock, report',
  commands: [
    { command: 'poll', description: '📊 تصويت: /poll السؤال | خيار1 | خيار2' },
    { command: 'report', description: '🚨 تبليغ الإدارة (بالرد)' },
    { command: 'pin', description: '📌 تثبيت رسالة (بالرد)', staffOnly: true },
    { command: 'unpin', description: '📌 إلغاء التثبيت', staffOnly: true },
    { command: 'del', description: '🗑 حذف رسالة (بالرد)', staffOnly: true },
    { command: 'purge', description: '🧹 حذف الرسائل حتى المُحددة (بالرد)', staffOnly: true },
    { command: 'lock', description: '🔒 قفل الكتابة في القروب', staffOnly: true },
    { command: 'unlock', description: '🔓 فتح الكتابة', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // /poll question | opt1 | opt2 ...
    bot.command('poll', async (ctx) => {
      const raw = ctx.message.text.split(' ').slice(1).join(' ');
      const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
      const question = parts.shift();
      if (!question || parts.length < 2) {
        await ctx.reply('📊 استخدم: /poll السؤال | خيار1 | خيار2 [| خيار3 ...]');
        return;
      }
      await ctx.replyWithPoll(question, parts.slice(0, 10), { is_anonymous: false });
    });

    // /report (reply) → ping chat admins.
    bot.command('report', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const replied = (
        ctx.message as { reply_to_message?: { from?: { id: number }; message_id?: number } }
      ).reply_to_message;
      if (!replied) {
        await ctx.reply('🚨 ردّ على الرسالة المُخالفة ثم اكتب /report');
        return;
      }
      try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        const mentions = admins
          .filter((a) => !a.user.is_bot)
          .slice(0, 5)
          .map((a) => `[‏](tg://user?id=${a.user.id})`)
          .join('');
        await ctx.reply(`🚨 تم إبلاغ الإدارة${mentions}`, {
          parse_mode: 'MarkdownV2',
          reply_parameters: { message_id: replied.message_id ?? ctx.message.message_id },
        });
      } catch {
        await ctx.reply('🚨 تم استلام البلاغ.');
      }
    });

    bot.command('pin', requireRole('admin'), async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: { message_id?: number } })
        .reply_to_message;
      if (!replied?.message_id) return void ctx.reply('📌 ردّ على الرسالة المراد تثبيتها.');
      const ok = await ctx.telegram
        .pinChatMessage(ctx.chat.id, replied.message_id, { disable_notification: false })
        .then(() => true)
        .catch(() => false);
      await ctx.reply(ok ? '📌 تم التثبيت.' : '⚠️ تعذّر التثبيت (تأكد أني مشرف).');
    });

    bot.command('unpin', requireRole('admin'), async (ctx) => {
      const ok = await ctx.telegram
        .unpinChatMessage(ctx.chat.id)
        .then(() => true)
        .catch(() => false);
      await ctx.reply(ok ? '📌 تم إلغاء التثبيت.' : '⚠️ تعذّر التنفيذ.');
    });

    bot.command('del', requireRole('admin'), async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: { message_id?: number } })
        .reply_to_message;
      if (!replied?.message_id) return void ctx.reply('🗑 ردّ على الرسالة المراد حذفها.');
      await ctx.telegram.deleteMessage(ctx.chat.id, replied.message_id).catch(() => undefined);
      await ctx.deleteMessage().catch(() => undefined);
    });

    // /purge (reply) → delete everything from the replied message up to now.
    bot.command('purge', requireRole('admin'), async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: { message_id?: number } })
        .reply_to_message;
      if (!replied?.message_id) return void ctx.reply('🧹 ردّ على أول رسالة تريد الحذف منها.');
      const from = replied.message_id;
      const to = ctx.message.message_id;
      if (to - from > MAX_PURGE) {
        await ctx.reply(`🧹 الحد الأقصى ${MAX_PURGE} رسالة في المرة.`);
        return;
      }
      let deleted = 0;
      for (let id = from; id <= to; id++) {
        const ok = await ctx.telegram
          .deleteMessage(ctx.chat.id, id)
          .then(() => true)
          .catch(() => false);
        if (ok) deleted++;
      }
      await logAction(ctx.chat.id, 'purge', ctx.from.id, undefined, `${deleted} msgs`);
      const note = await ctx.reply(`🧹 تم حذف ${deleted} رسالة.`);
      // Auto-remove the confirmation after a few seconds.
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, note.message_id).catch(() => undefined);
      }, 4000).unref?.();
    });

    bot.command('lock', requireRole('manager'), async (ctx) => {
      const ok = await ctx.telegram
        .setChatPermissions(ctx.chat.id, { can_send_messages: false })
        .then(() => true)
        .catch(() => false);
      if (ok) await logAction(ctx.chat.id, 'lock', ctx.from.id);
      await ctx.reply(ok ? '🔒 تم قفل الكتابة في القروب.' : '⚠️ تعذّر التنفيذ (تأكد أني مشرف).');
    });

    bot.command('unlock', requireRole('manager'), async (ctx) => {
      const ok = await ctx.telegram
        .setChatPermissions(ctx.chat.id, {
          can_send_messages: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_send_audios: true,
          can_send_documents: true,
          can_send_photos: true,
          can_send_videos: true,
          can_send_video_notes: true,
          can_send_voice_notes: true,
          can_invite_users: true,
        })
        .then(() => true)
        .catch(() => false);
      if (ok) await logAction(ctx.chat.id, 'unlock', ctx.from.id);
      await ctx.reply(ok ? '🔓 تم فتح الكتابة.' : '⚠️ تعذّر التنفيذ.');
    });
  },
};
