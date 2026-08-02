import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { displayName } from '../../utils/format';
import {
  createTicket,
  listOpenTickets,
  getTicket,
  replyTicket,
  closeTicket,
} from '../../services/ticket.service';
import { parseIdAndText, parseId, snippet } from './logic';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Support tickets: members open complaints/suggestions; admins manage & reply. */
export const ticketsPlugin: Plugin = {
  name: 'tickets',
  description: 'Support tickets (complaints/suggestions) with admin management',
  commands: [
    { command: 'ticket', description: '🎫 افتح تذكرة: /ticket نص الشكوى/الاقتراح' },
    { command: 'tickets', description: '📋 التذاكر المفتوحة', staffOnly: true },
    { command: 'ticketview', description: '🔍 عرض تذكرة: /ticketview 5', staffOnly: true },
    { command: 'ticketreply', description: '📩 رد على تذكرة: /ticketreply 5 نص', staffOnly: true },
    { command: 'ticketclose', description: '✅ إغلاق تذكرة: /ticketclose 5', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // Member opens a ticket.
    bot.command('ticket', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!text) return void ctx.reply('🎫 اكتب شكواك أو اقتراحك:\n/ticket نص الرسالة');
      const t = await createTicket(ctx.chat!.id, ctx.from.id, displayName(ctx.from), text);
      await ctx.reply(`🎫 تم استلام تذكرتك رقم #${t.id}. ستراجعها الإدارة قريباً. شكراً لك 🙏`);
    });

    // Admin: list open tickets.
    bot.command('tickets', requireRole('admin'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const rows = await listOpenTickets(ctx.chat!.id);
      if (!rows.length) return void ctx.reply('📋 لا توجد تذاكر مفتوحة 🎉');
      const list = rows.map((t) => `#${t.id} — ${t.userName ?? t.userId}: ${snippet(t.message)}`).join('\n');
      await ctx.reply(`📋 التذاكر المفتوحة (${rows.length}):\n${list}\n\nللعرض: /ticketview <رقم>`);
    });

    // Admin: view one ticket.
    bot.command('ticketview', requireRole('admin'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const id = parseId(ctx.message.text.split(' ').slice(1).join(' '));
      if (id === null) return void ctx.reply('🔍 استخدم: /ticketview 5');
      const t = await getTicket(id);
      if (!t || t.chatId !== BigInt(ctx.chat!.id)) return void ctx.reply('❌ لا توجد تذكرة بهذا الرقم.');
      await ctx.reply(
        `🎫 تذكرة #${t.id}\n👤 ${t.userName ?? t.userId}\n📅 ${t.createdAt.toLocaleString('ar')}\n📌 الحالة: ${t.status === 'open' ? 'مفتوحة' : 'مغلقة'}\n\n💬 ${t.message}` +
          (t.reply ? `\n\n📩 رد الإدارة: ${t.reply}` : ''),
      );
    });

    // Admin: reply to a ticket (posts to the group, tags the member, closes it).
    bot.command('ticketreply', requireRole('admin'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const parsed = parseIdAndText(ctx.message.text.split(' ').slice(1).join(' '));
      if (!parsed) return void ctx.reply('📩 استخدم: /ticketreply 5 نص الرد');
      const t = await getTicket(parsed.id);
      if (!t || t.chatId !== BigInt(ctx.chat!.id)) return void ctx.reply('❌ لا توجد تذكرة بهذا الرقم.');
      await replyTicket(t.id, parsed.text);
      const mention = `<a href="tg://user?id=${t.userId}">${escapeHtml(t.userName ?? 'العضو')}</a>`;
      await ctx.reply(`📩 رد الإدارة على تذكرة #${t.id} ${mention}:\n${escapeHtml(parsed.text)}`, { parse_mode: 'HTML' });
    });

    // Admin: close without replying.
    bot.command('ticketclose', requireRole('admin'), async (ctx) => {
      if (!isGroup(ctx)) return;
      const id = parseId(ctx.message.text.split(' ').slice(1).join(' '));
      if (id === null) return void ctx.reply('✅ استخدم: /ticketclose 5');
      const t = await getTicket(id);
      if (!t || t.chatId !== BigInt(ctx.chat!.id)) return void ctx.reply('❌ لا توجد تذكرة بهذا الرقم.');
      await closeTicket(t.id);
      await ctx.reply(`✅ تم إغلاق التذكرة #${t.id}.`);
    });
  },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
