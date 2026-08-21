import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { saveNote, getNote, deleteNote, listNotes } from '../../services/notes.service';

/**
 * Saved notes (like Rose bot). Admins store reusable text under a name;
 * anyone recalls it with /get <name> or by typing #<name>.
 */
export const notesPlugin: Plugin = {
  name: 'notes',
  description: 'Save & recall named notes (/save, /get, #name, /notes)',
  commands: [
    { command: 'save', description: '📝 حفظ ملاحظة: /save اسم النص', staffOnly: true },
    { command: 'get', description: '📄 استرجاع ملاحظة: /get اسم' },
    { command: 'notes', description: '📚 قائمة الملاحظات' },
    { command: 'clearnote', description: '🗑 حذف ملاحظة: /clearnote اسم', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // /save <name> <content...>  (or reply to a message with /save <name>)
    bot.command('save', requireRole('manager'), async (ctx) => {
      const parts = ctx.message.text.split(' ').slice(1);
      const name = parts.shift();
      if (!name) {
        await ctx.reply('📝 استخدم: /save اسم_الملاحظة النص');
        return;
      }
      let content = parts.join(' ').trim();
      const replied = (ctx.message as { reply_to_message?: { text?: string } }).reply_to_message;
      if (!content && replied?.text) content = replied.text;
      if (!content) {
        await ctx.reply('📝 اكتب نص الملاحظة أو ردّ على رسالة.');
        return;
      }
      await saveNote(ctx.chat.id, name, content, ctx.from.id);
      await ctx.reply(`✅ حُفظت الملاحظة «${name}». استرجعها بـ /get ${name} أو #${name}`);
    });

    bot.command('get', async (ctx) => {
      const name = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!name) {
        await ctx.reply('📄 استخدم: /get اسم_الملاحظة');
        return;
      }
      const note = await getNote(ctx.chat.id, name);
      await ctx.reply(note ? note.content : '❌ لا توجد ملاحظة بهذا الاسم.');
    });

    bot.command('notes', async (ctx) => {
      const notes = await listNotes(ctx.chat.id);
      if (!notes.length) {
        await ctx.reply('📚 لا توجد ملاحظات محفوظة.');
        return;
      }
      const list = notes.map((n) => `• #${n.name}`).join('\n');
      await ctx.reply(`📚 الملاحظات المحفوظة:\n${list}`);
    });

    bot.command('clearnote', requireRole('manager'), async (ctx) => {
      const name = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!name) {
        await ctx.reply('🗑 استخدم: /clearnote اسم_الملاحظة');
        return;
      }
      const ok = await deleteNote(ctx.chat.id, name);
      await ctx.reply(ok ? `🗑 حُذفت الملاحظة «${name}».` : '❌ لا توجد ملاحظة بهذا الاسم.');
    });

    // Hashtag recall: a message that is exactly #name → send that note.
    // Passes through (next) so other passive listeners still run.
    bot.on(message('text'), async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (
        ctx.chat &&
        (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') &&
        /^#[\p{L}\p{N}_]+$/u.test(text)
      ) {
        const note = await getNote(ctx.chat.id, text.slice(1));
        if (note) await ctx.reply(note.content).catch(() => undefined);
      }
      return next();
    });
  },
};
