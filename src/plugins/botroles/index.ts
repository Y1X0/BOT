import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole, invalidateRole, resolveUserRole, canActOn, isBotOwner, type Role } from '../../utils/permissions';
import { resolveTarget, displayName } from '../../utils/format';
import { setChatRole, removeChatRole, listChatRoles, getChatRole, type AssignableRole } from '../../services/roles.service';
import { prisma } from '../../core/database';
import { env } from '../../config/env';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Human badge for each rank, used in confirmations and the /roles list. */
const BADGE: Record<string, string> = {
  owner: '👑 مالك',
  supervisor: '🛡 مشرف',
  manager: '🔰 مدير',
  admin: '⭐ أدمن',
  vip: '💎 مميز',
  member: '👤 عضو',
};

// Assignable ranks, strongest first, for the /roles list ordering.
const RANK_ORDER: Record<string, number> = { supervisor: 0, manager: 1, admin: 2, vip: 3 };

/**
 * Custom bot ranks (رتب البوت) — a single hierarchy independent of Telegram's
 * own admin, though a Telegram admin counts as 🔰 مدير and the creator as 👑 مالك.
 * Rules: you can only grant a rank BELOW yours, and only to someone currently
 * below you; nobody can outrank or act on an equal-or-higher member.
 */
export const botRolesPlugin: Plugin = {
  name: 'botroles',
  description: 'Unified in-bot ranks (supervisor/manager/admin/vip) assignable by reply',
  commands: [
    { command: 'rmod', description: '🛡 رفع مشرف (بالرد)', staffOnly: true },
    { command: 'rmanager', description: '🔰 رفع مدير (بالرد)', staffOnly: true },
    { command: 'radmin', description: '⭐ رفع أدمن (بالرد)', staffOnly: true },
    { command: 'rvip', description: '💎 رفع مميّز (بالرد)', staffOnly: true },
    { command: 'unrank', description: '🗑 تنزيل الرتبة (بالرد)', staffOnly: true },
    { command: 'roles', description: '📋 مين المشرفين والرتب بالجروب' },
  ],

  register(bot: Telegraf<BotContext>) {
    const assign = (role: AssignableRole) => async (ctx: BotContext) => {
      if (!isGroup(ctx) || !ctx.chat) return;
      const actor: Role = ctx.state.role ?? 'member';
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('↩️ ردّ على رسالة الشخص اللي بدك تعطيه الرتبة.');
      if ((target as { is_bot?: boolean }).is_bot) return void ctx.reply('🤖 ما بينفع تعطي رتبة لبوت.');

      // You may only grant a rank strictly BELOW your own…
      if (!canActOn(actor, role)) {
        return void ctx.reply(`⛔️ ما بتقدر ترفع لرتبة ${BADGE[role]} — لازم تكون أعلى منها.`);
      }
      // …and only to someone currently below you.
      const targetRole = await resolveUserRole(ctx, target.id);
      if (!canActOn(actor, targetRole)) {
        return void ctx.reply(`⛔️ ${displayName(target)} رتبته (${BADGE[targetRole]}) مساوية أو أعلى من رتبتك.`);
      }

      const name = displayName(target);
      await setChatRole(ctx.chat.id, target.id, role, name, ctx.from?.id ?? null);
      invalidateRole(ctx.chat.id, target.id);
      await ctx.reply(`✅ صار ${name} الآن ${BADGE[role]} بهالجروب.\nالرتبة محفوظة بالبوت وبتعطيه صلاحياته حتى لو مش أدمن بتيليجرام.`);
    };

    bot.command('rmod', requireRole('owner'), assign('supervisor')); // only the owner promotes a مشرف
    bot.command('rmanager', requireRole('supervisor'), assign('manager'));
    bot.command('radmin', requireRole('manager'), assign('admin'));
    bot.command('rvip', requireRole('manager'), assign('vip'));

    bot.command('unrank', requireRole('manager'), async (ctx) => {
      if (!isGroup(ctx) || !ctx.chat) return;
      const actor: Role = ctx.state.role ?? 'member';
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('↩️ ردّ على رسالة الشخص اللي بدك تنزّل رتبته.');
      const targetRole = await resolveUserRole(ctx, target.id);
      if (!canActOn(actor, targetRole)) {
        return void ctx.reply(`⛔️ ما بتقدر تنزّل ${displayName(target)} — رتبته (${BADGE[targetRole]}) مساوية أو أعلى منك.`);
      }
      const removed = await removeChatRole(ctx.chat.id, target.id);
      invalidateRole(ctx.chat.id, target.id);
      await ctx.reply(
        removed
          ? `🗑 تم تنزيل رتبة ${displayName(target)} بهالجروب.`
          : `ℹ️ ${displayName(target)} ما عنده رتبة بوت أصلاً.`,
      );
    });

    // Full picture in one place: Telegram admins + custom bot ranks.
    bot.command('roles', async (ctx) => {
      if (!isGroup(ctx) || !ctx.chat) return;

      // 1) Telegram-side: creator + administrators (skip bots).
      let creatorLine = '';
      const tgAdmins: string[] = [];
      try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        for (const a of admins) {
          if (a.user.is_bot) continue;
          if (a.status === 'creator') creatorLine = `👑 المالك: ${displayName(a.user)}`;
          else tgAdmins.push(`⭐ ${displayName(a.user)}`);
        }
      } catch {
        /* member-list may be unavailable — show whatever we can */
      }

      // 2) Bot-side: custom ranks assigned through the bot.
      const roles = await listChatRoles(ctx.chat.id);
      roles.sort((a, b) => (RANK_ORDER[a.role] ?? 9) - (RANK_ORDER[b.role] ?? 9));
      const botLines = roles.map((r) => `${BADGE[r.role] ?? r.role} — ${r.name ?? r.userId}`);

      const parts: string[] = ['📋 إدارة الجروب:'];
      if (creatorLine) parts.push(`\n${creatorLine}`);
      parts.push(
        tgAdmins.length ? `\n🛡 مشرفو تيليجرام (${tgAdmins.length}):\n${tgAdmins.join('\n')}` : '\n🛡 ما في مشرفين ظاهرين بتيليجرام.',
      );
      parts.push(
        botLines.length
          ? `\n🔰 رتب البوت (${botLines.length}):\n${botLines.join('\n')}`
          : '\n🔰 رتب البوت: ما في. للتعيين ردّ على العضو واكتب «رفع مشرف/مدير/ادمن/مميز».',
      );
      await ctx.reply(parts.join('\n'));
    });

    // Diagnostic (owner-only): why an admin/rank isn't recognized, and whether
    // ranks are being lost. Reply to someone to inspect them; else the sender.
    bot.command('rolesdiag', async (ctx) => {
      if (!isGroup(ctx) || !ctx.chat) return;
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const target = resolveTarget(ctx) ?? ctx.from;

      // Raw Telegram status.
      let tgStatus = 'غير معروف';
      try {
        const m = await ctx.telegram.getChatMember(ctx.chat.id, target.id);
        tgStatus = m.status;
      } catch (e) {
        tgStatus = `فشل getChatMember: ${e instanceof Error ? e.message : e}`;
      }
      let inAdminList = false;
      try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        inAdminList = admins.some((a) => a.user?.id === target.id);
      } catch {
        /* ignore */
      }

      const dbRole = await getChatRole(ctx.chat.id, target.id).catch(() => null);
      const resolved = await resolveUserRole(ctx, target.id).catch(() => 'member');
      const rowCount = await prisma.chatRole
        .count({ where: { chatId: BigInt(ctx.chat.id) } })
        .catch(() => -1);

      // Is the DB ephemeral? SQLite on a container without a mounted volume is
      // wiped on every redeploy — the usual cause of "ranks reset".
      const isSqlite = env.DATABASE_PROVIDER !== 'postgresql';
      const dbLine = isSqlite
        ? `⚠️ SQLite (<code>${escapeHtml(env.DATABASE_URL)}</code>)\nهاي بتتصفّر كل Redeploy إذا مش مربوطة على Volume. الحل: Postgres أو Volume ثابت.`
        : `✅ Postgres (ثابتة)`;

      const lines = [
        '🩺 <b>تشخيص الرتب</b>',
        `• الشخص: ${escapeHtml(displayName(target))} (<code>${target.id}</code>)`,
        `• حالة تيليجرام: <b>${escapeHtml(tgStatus)}</b>`,
        `• بقائمة المشرفين: <b>${inAdminList ? 'نعم' : 'لا'}</b>`,
        `• رتبة البوت المحفوظة: <b>${dbRole ?? 'لا يوجد'}</b>`,
        `• الرتبة النهائية المحسوبة: <b>${resolved}</b>`,
        `• عدد رتب البوت بهالجروب: <b>${rowCount}</b>`,
        `• قاعدة البيانات: ${dbLine}`,
      ];
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' }).catch(() => undefined);
    });
  },
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
