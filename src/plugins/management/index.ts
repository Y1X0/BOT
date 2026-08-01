import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { env } from '../../config/env';
import { requireRole } from '../../utils/permissions';
import { displayName } from '../../utils/format';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:management');

/** Tracks which chats we've currently locked via night mode (transition-only calls). */
const nightLocked = new Set<string>();

function currentHour(tz = env.DEFAULT_TIMEZONE): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date()),
  );
}

/** Is `hour` within the night window [start, end) (handles overnight wrap)? */
function inNightWindow(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export const managementPlugin: Plugin = {
  name: 'management',
  description: 'Night mode, service-message cleanup, mention-all, admins list',
  commands: [
    { command: 'nightmode', description: '🌙 وضع الليل: /nightmode on 23 6', staffOnly: true },
    { command: 'all', description: '📢 منشن كل الأعضاء', staffOnly: true },
    { command: 'admins', description: '👮 قائمة الأدمن' },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- Night mode config ---
    bot.command('nightmode', requireRole('admin'), async (ctx) => {
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const state = parts[0];
      if (state !== 'on' && state !== 'off') {
        await ctx.reply('🌙 استخدم: /nightmode on 23 6   (تفعيل من 11م حتى 6ص)\nأو: /nightmode off');
        return;
      }
      const start = Math.min(Math.max(parseInt(parts[1] ?? '0', 10) || 0, 0), 23);
      const end = Math.min(Math.max(parseInt(parts[2] ?? '6', 10) || 6, 0), 23);
      await prisma.chatSettings.update({
        where: { chatId: BigInt(ctx.chat.id) },
        data: { nightModeEnabled: state === 'on', nightStartHour: start, nightEndHour: end },
      });
      await ctx.reply(
        state === 'on'
          ? `🌙 تم تفعيل وضع الليل: القفل من الساعة ${start}:00 حتى ${end}:00.`
          : '☀️ تم إيقاف وضع الليل.',
      );
    });

    // --- Mention all registered members (in batches) ---
    bot.command('all', requireRole('moderator'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const note = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const members = await prisma.member.findMany({
        where: { chatId: BigInt(ctx.chat.id) },
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
      });
      if (!members.length) return void ctx.reply('لا يوجد أعضاء مسجّلون بعد.');

      const mentions = members.map(
        (m) => `<a href="tg://user?id=${m.userId}">${escapeHtml(m.firstName ?? 'عضو')}</a>`,
      );
      const header = note ? `📢 ${escapeHtml(note)}\n\n` : '📢 نداء للجميع:\n\n';
      // 8 mentions per message to avoid hitting entity limits.
      for (let i = 0; i < mentions.length; i += 8) {
        const chunk = mentions.slice(i, i + 8).join(' ');
        await ctx
          .reply((i === 0 ? header : '') + chunk, { parse_mode: 'HTML' })
          .catch(() => undefined);
      }
    });

    // --- Admins list ---
    bot.command('admins', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        const list = admins
          .filter((a) => !a.user.is_bot)
          .map((a) => `• ${displayName(a.user)}${a.status === 'creator' ? ' 👑' : ''}`)
          .join('\n');
        await ctx.reply(`👮 المشرفون:\n${list}`);
      } catch {
        await ctx.reply('❌ تعذّر جلب قائمة المشرفين.');
      }
    });

    // --- Auto-delete service messages (join/leave) ---
    const cleanup = async (ctx: BotContext, next: () => Promise<void>) => {
      if (ctx.state.settings?.cleanServiceEnabled) {
        await ctx.deleteMessage().catch(() => undefined);
      }
      return next(); // let welcome/farewell still run
    };
    bot.on(message('new_chat_members'), cleanup);
    bot.on(message('left_chat_member'), cleanup);

    // --- Night-mode ticker: lock/unlock on the minute ---
    const interval = setInterval(() => {
      void tickNightMode(bot);
    }, 60_000);
    interval.unref?.();
  },
};

async function tickNightMode(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const chats = await prisma.chatSettings.findMany({ where: { nightModeEnabled: true } });
    const hour = currentHour();
    for (const c of chats) {
      const key = String(c.chatId);
      const shouldLock = inNightWindow(hour, c.nightStartHour, c.nightEndHour);
      const isLocked = nightLocked.has(key);
      if (shouldLock && !isLocked) {
        await bot.telegram
          .setChatPermissions(Number(c.chatId), { can_send_messages: false })
          .then(() => {
            nightLocked.add(key);
            return bot.telegram.sendMessage(Number(c.chatId), '🌙 وضع الليل: تم إغلاق الكتابة حتى الصباح.');
          })
          .catch(() => undefined);
      } else if (!shouldLock && isLocked) {
        await bot.telegram
          .setChatPermissions(Number(c.chatId), {
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
          })
          .then(() => {
            nightLocked.delete(key);
            return bot.telegram.sendMessage(Number(c.chatId), '☀️ صباح الخير! تم فتح الكتابة.');
          })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    log.warn({ err }, 'night mode tick failed');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
