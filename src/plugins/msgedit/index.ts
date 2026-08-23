import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { hasRole } from '../../utils/permissions';
import {
  setOverride,
  listOverrides,
  removeOverride,
  clearOverrides,
  overrideCount,
} from '../../services/message-overrides.service';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:msgedit');

/** An in-progress edit: keyed by user id. `original` = the bot text being
 *  replaced; `pending` = the new content the owner sent, awaiting «تم». */
interface EditSession {
  chatId: number;
  original: string;
  pending?: { text: string; entities: unknown[] };
  at: number;
}
const sessions = new Map<number, EditSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

const isDone = (t: string): boolean => /^(تم|خلص|خلصت|حفظ|save|done)$/i.test(t);
const isCancel = (t: string): boolean => /^(الغاء|إلغاء|الغاء تعديل|إلغاء التعديل|كنسل|cancel)$/i.test(t);

// Short stable id for an override key, so it fits in callback data.
function shortId(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const idToKey = new Map<string, string>();

/** Owner tool: reply «تعديل» to any bot message, send the new version, then «تم»
 *  — the replacement is saved bot-wide and swapped in wherever that message is
 *  sent. Founder-only (it changes every group). */
export const msgEditPlugin: Plugin = {
  name: 'msgedit',
  description: 'Owner-editable bot messages: reply «تعديل», send new text, «تم»',
  commands: [{ command: 'msgedits', description: '📝 الرسائل المعدّلة (المالك الأساسي)', staffOnly: true }],

  register(bot: Telegraf<BotContext>) {
    // --- The wizard: runs on plain text (registered before aliases). ---
    bot.on(message('text'), async (ctx, next) => {
      const from = ctx.from;
      const chat = ctx.chat;
      if (!from || !chat) return next();
      const text = ctx.message.text.trim();

      // Active session → capture content / finalize / cancel.
      const sess = sessions.get(from.id);
      if (sess && sess.chatId === chat.id) {
        if (Date.now() - sess.at > SESSION_TTL_MS) {
          sessions.delete(from.id);
          return next();
        }
        if (isCancel(text)) {
          sessions.delete(from.id);
          await ctx.reply('❌ تم إلغاء التعديل.').catch(() => undefined);
          return;
        }
        if (isDone(text)) {
          if (!sess.pending) {
            await ctx.reply('✏️ أرسل الشكل الجديد للرسالة أول، وبعدين اكتب «تم».').catch(() => undefined);
            return;
          }
          await setOverride(sess.original, sess.pending.text, sess.pending.entities).catch((err) =>
            log.warn({ err }, 'setOverride failed'),
          );
          sessions.delete(from.id);
          await ctx.reply('✅ تم حفظ التعديل — رح يظهر بكل الجروبات من هلأ.').catch(() => undefined);
          return;
        }
        // Any other text = the new content.
        sess.pending = { text: ctx.message.text, entities: (ctx.message.entities as unknown[]) ?? [] };
        sess.at = Date.now();
        await ctx.reply('👍 استلمت النسخة الجديدة. اكتب «تم» للحفظ، أو أرسل نص ثاني لتغييره.').catch(() => undefined);
        return;
      }

      // Start: reply «تعديل» to a message the BOT sent.
      if (/^تعديل(\s|$)/.test(text)) {
        if (!hasRole(ctx.state.role ?? 'member', 'founder')) return next(); // silent for non-founder
        const r = ctx.message.reply_to_message as
          | { from?: { id?: number }; text?: string; caption?: string }
          | undefined;
        if (!r) {
          await ctx.reply('↩️ ردّ على رسالة أرسلها البوت واكتب «تعديل».').catch(() => undefined);
          return;
        }
        if (r.from?.id !== ctx.botInfo?.id) {
          await ctx.reply('↩️ لازم تردّ على رسالة من البوت نفسه.').catch(() => undefined);
          return;
        }
        const orig = (r.text ?? r.caption ?? '').trim();
        if (!orig) {
          await ctx.reply('⚠️ هاي الرسالة ما فيها نص أقدر أعدّله.').catch(() => undefined);
          return;
        }
        sessions.set(from.id, { chatId: chat.id, original: orig, at: Date.now() });
        await ctx
          .reply('✏️ أرسل الشكل الجديد للرسالة، وبعدين اكتب «تم».\nللإلغاء اكتب: إلغاء')
          .catch(() => undefined);
        return;
      }

      return next();
    });

    // --- List / manage saved overrides (founder only). ---
    bot.command('msgedits', async (ctx) => {
      if (!hasRole(ctx.state.role ?? 'member', 'founder')) return;
      const items = listOverrides();
      if (!items.length) {
        await ctx.reply('📝 ما في رسائل معدّلة.\nللتعديل: ردّ على رسالة من البوت واكتب «تعديل».').catch(() => undefined);
        return;
      }
      idToKey.clear();
      const rows = items.slice(0, 30).map((it) => {
        const id = shortId(it.key);
        idToKey.set(id, it.key);
        const label = `🗑 ${it.orig.slice(0, 30)}${it.orig.length > 30 ? '…' : ''}`;
        return [Markup.button.callback(label, `moved:${id}`)];
      });
      rows.push([Markup.button.callback('🧹 امسح الكل', 'moved:__all__')]);
      await ctx
        .reply(`📝 <b>الرسائل المعدّلة</b> — <b>${items.length}</b>\nاضغط لحذف تعديل (يرجع للأصلي):`, {
          ...Markup.inlineKeyboard(rows),
        })
        .catch(() => undefined);
    });

    bot.action(/^moved:(.+)$/, async (ctx) => {
      if (!hasRole(ctx.state.role ?? 'member', 'founder')) {
        await ctx.answerCbQuery('للمالك الأساسي فقط').catch(() => undefined);
        return;
      }
      const id = ctx.match[1];
      if (id === '__all__') {
        await clearOverrides().catch(() => undefined);
        await ctx.answerCbQuery('تم مسح كل التعديلات').catch(() => undefined);
        await ctx.editMessageText('🧹 تم مسح كل الرسائل المعدّلة — رجعت للأصلي.').catch(() => undefined);
        return;
      }
      const key = idToKey.get(id);
      if (!key) {
        await ctx.answerCbQuery('انتهت الصلاحية، افتح القائمة من جديد.').catch(() => undefined);
        return;
      }
      await removeOverride(key).catch(() => undefined);
      idToKey.delete(id);
      await ctx.answerCbQuery('تم الحذف — رجعت للأصلي').catch(() => undefined);
      await ctx.editMessageText(`✅ تم حذف التعديل. المتبقّي: ${overrideCount()}.`).catch(() => undefined);
    });
  },
};
