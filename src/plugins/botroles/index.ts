import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole, invalidateRole, resolveUserRole, canActOn, hasRole, type Role } from '../../utils/permissions';
import { resolveTarget, displayName, mention } from '../../utils/format';
import { setChatRole, removeChatRole, listChatRoles, getChatRole, type AssignableRole } from '../../services/roles.service';
import { prisma } from '../../core/database';
import { env } from '../../config/env';

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Human badge for each rank, used in confirmations and the /roles list. */
const BADGE: Record<string, string> = {
  founder: '👑 مالك أساسي',
  owner: '⭐ مالك',
  manager: '🔰 مدير',
  admin: '🛡 أدمن',
  vip: '💎 مميز',
  member: '👤 عضو',
};

/**
 * In-bot ranks (رتب البوت). The hierarchy, high→low:
 *   👑 مالك أساسي (founder = creator + OWNER_IDS) > ⭐ مالك (owner) >
 *   🔰 مدير (manager) > 🛡 أدمن (admin, = a Telegram admin too) > 💎 مميز (vip) > عضو.
 * Rules: you can only grant a rank BELOW yours, and only to someone currently
 * below you; nobody can outrank or act on an equal-or-higher member.
 */
export const botRolesPlugin: Plugin = {
  name: 'botroles',
  description: 'In-bot ranks (owner/manager/admin/vip) assignable by reply',
  commands: [
    { command: 'rowner', description: '⭐ رفع مالك (بالرد)', staffOnly: true },
    { command: 'rmanager', description: '🔰 رفع مدير (بالرد)', staffOnly: true },
    { command: 'radmin', description: '🛡 رفع أدمن (بالرد)', staffOnly: true },
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
      const men = mention({ id: target.id, first_name: name }).toString();
      await ctx.reply(`✦ 🎖 تم رفع ${men} إلى <b>${BADGE[role]}</b> ✦`);
    };

    bot.command('rowner', requireRole('founder'), assign('owner')); // only the founder promotes an owner
    bot.command('rmanager', requireRole('owner'), assign('manager'));
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
      const men = mention({ id: target.id, first_name: displayName(target) }).toString();
      await ctx.reply(
        removed
          ? `✦ 🗑 تم تنزيل ${men} من رتبته ✦`
          : `ℹ️ ${men} ما عنده رتبة بوت أصلاً.`,
      );
    });

    // Full picture in one place: Telegram admins + in-bot ranks, as an elegant
    // board with a clickable mention for every rank-holder. Someone who is BOTH
    // a Telegram admin AND holds a bot rank intentionally appears in both.
    bot.command('roles', async (ctx) => {
      if (!isGroup(ctx) || !ctx.chat) return;

      const RULE = '➖➖➖➖➖➖➖➖➖➖';
      const men = (id: number | string, name?: string | null): string =>
        mention({ id: Number(id), first_name: name || 'عضو' }).toString();

      // 1) Telegram-side: creator + administrators (skip bots).
      let founder = '';
      const tgAdmins: string[] = [];
      try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        for (const a of admins) {
          if (a.user.is_bot) continue;
          if (a.status === 'creator') founder = men(a.user.id, a.user.first_name);
          else tgAdmins.push(men(a.user.id, a.user.first_name));
        }
      } catch {
        /* member-list may be unavailable — show whatever we can */
      }

      // 2) Bot-side: in-bot ranks, grouped by tier (strongest first).
      const roles = await listChatRoles(ctx.chat.id);
      const byTier = new Map<string, string[]>();
      for (const r of roles) {
        if (!byTier.has(r.role)) byTier.set(r.role, []);
        byTier.get(r.role)!.push(men(r.userId, r.name));
      }

      const L: string[] = [];
      L.push('👑✦ <b>هَيْبَة الإدارة</b> ✦👑');
      L.push(RULE);

      // Founder.
      if (founder) {
        L.push('');
        L.push('👑 <b>المالك الأساسي</b>');
        L.push(`   ◈ ${founder}`);
      }

      // Telegram admins.
      if (tgAdmins.length) {
        L.push('');
        L.push(`🛡 <b>أدمن تيليجرام</b> — <b>${tgAdmins.length}</b>`);
        for (const m of tgAdmins) L.push(`   ◈ ${m}`);
      }

      // In-bot ranks.
      L.push('');
      L.push('⚜️ <b>رُتَب البوت</b> ⚜️');
      L.push(RULE);
      const TIERS: { role: string; label: string }[] = [
        { role: 'owner', label: '⭐ <b>مالك</b>' },
        { role: 'manager', label: '🔰 <b>مدير</b>' },
        { role: 'admin', label: '🛡 <b>أدمن</b>' },
        { role: 'vip', label: '💎 <b>مميّز</b>' },
      ];
      let botCount = 0;
      for (const { role, label } of TIERS) {
        const list = byTier.get(role);
        if (!list?.length) continue;
        botCount += list.length;
        L.push('');
        L.push(`${label} — <b>${list.length}</b>`);
        for (const m of list) L.push(`   ◈ ${m}`);
      }
      if (!botCount) {
        L.push('');
        L.push('لا يوجد بعد — للتعيين ردّ على العضو واكتب «رفع مالك / مدير / ادمن / مميز».');
      }

      // Footer.
      L.push('');
      L.push(RULE);
      L.push(`📊 الإجمالي: <b>${tgAdmins.length + botCount + (founder ? 1 : 0)}</b> صاحب رتبة`);

      // No parse_mode: the outgoing interceptor turns the <b>/<a> tags into real
      // entities (mentions work without a username via tg://user links).
      await ctx.reply(L.join('\n')).catch(() => undefined);
    });

    // Diagnostic (owner-only): why an admin/rank isn't recognized, and whether
    // ranks are being lost. Reply to someone to inspect them; else the sender.
    bot.command('rolesdiag', async (ctx) => {
      if (!isGroup(ctx) || !ctx.chat) return;
      if (!hasRole(ctx.state.role ?? 'member', 'founder')) return;
      const target = resolveTarget(ctx) ?? ctx.from;
      if (!target) return;

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
