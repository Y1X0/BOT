import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole, resolveUserRole, canActOn, rankOf, type Role } from '../../utils/permissions';
import {
  addWarning,
  countWarnings,
  removeWarning,
  resetWarnings,
  logAction,
} from '../../services/moderation.service';
import { addFilter, deleteFilter, listFilters } from '../../services/filters.service';
import {
  muteUser,
  unmuteUser,
  kickUser,
  banUser,
  unbanUser,
  applyWarnAction,
} from '../../utils/moderation-actions';
import { mention, resolveTarget } from '../../utils/format';
import { parseDuration, formatDuration } from '../../utils/duration';

/** Full send permissions — used to lift a /restrict. */
const FULL_SEND_PERMS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
};

export const moderationPlugin: Plugin = {
  name: 'moderation',
  description: 'Warnings, mute/kick/ban, word filters, promote',
  commands: [
    { command: 'warn', description: '⚠️ تحذير عضو (بالرد)', staffOnly: true },
    { command: 'unwarn', description: '✅ إزالة تحذير (بالرد)', staffOnly: true },
    { command: 'warns', description: '📊 عرض تحذيرات عضو (بالرد)', staffOnly: true },
    { command: 'mute', description: '🔇 كتم عضو (بالرد)', staffOnly: true },
    { command: 'tmute', description: '⏳ كتم مؤقت: /tmute 30m (بالرد)', staffOnly: true },
    { command: 'unmute', description: '🔊 إلغاء كتم (بالرد)', staffOnly: true },
    { command: 'kick', description: '👢 طرد عضو (بالرد)', staffOnly: true },
    { command: 'ban', description: '🚫 حظر عضو (بالرد)', staffOnly: true },
    { command: 'tban', description: '⏳ حظر مؤقت: /tban 2h (بالرد)', staffOnly: true },
    { command: 'unban', description: '✅ إلغاء حظر (بالرد)', staffOnly: true },
    { command: 'promote', description: '⬆️ ترقية عضو لمشرف (بالرد)', staffOnly: true },
    { command: 'demote', description: '⬇️ تنزيل مشرف (بالرد)', staffOnly: true },
    { command: 'restrict', description: '🔗 تقييد كامل (منع كل شيء، بالرد)', staffOnly: true },
    { command: 'unrestrict', description: '✅ رفع التقييد (بالرد)', staffOnly: true },
    { command: 'addfilter', description: '🚫 إضافة كلمة ممنوعة', staffOnly: true },
    { command: 'delfilter', description: '➖ حذف كلمة ممنوعة', staffOnly: true },
    { command: 'filters', description: '📋 عرض الكلمات الممنوعة', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // /warn (reply) [reason]
    bot.command('warn', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.warn_usage'));
      if (await isProtected(ctx, target.id)) return void ctx.reply(t('mod.cant_target_admin'));

      const reason = ctx.message.text.split(' ').slice(1).join(' ').trim() || t('mod.warn_reason_default');
      const count = await addWarning(ctx.chat.id, target.id, ctx.from.id, reason);
      const settings = ctx.state.settings!;
      await logAction(ctx.chat.id, 'warn', ctx.from.id, target.id, reason);

      await ctx.reply(
        t('mod.warned', { name: mention(target), count, max: settings.maxWarnings, reason }),
      );

      if (count >= settings.maxWarnings) {
        const applied = await applyWarnAction(ctx, target.id, settings.warnAction);
        if (applied !== 'none') {
          await resetWarnings(ctx.chat.id, target.id);
          await ctx.reply(t(`mod.action_${applied}`, { name: mention(target) }));
          await logAction(ctx.chat.id, `auto_${applied}`, ctx.from.id, target.id, 'warn limit');
        }
      }
    });

    bot.command('unwarn', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.need_reply'));
      const count = await removeWarning(ctx.chat.id, target.id);
      await ctx.reply(t('mod.unwarn_done', { name: mention(target), count }));
    });

    bot.command('warns', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx) ?? ctx.from;
      const count = await countWarnings(ctx.chat.id, target.id);
      if (count === 0) return void ctx.reply(t('mod.warns_none', { name: mention(target) }));
      await ctx.reply(
        t('mod.warns_list', { name: mention(target), count, max: ctx.state.settings!.maxWarnings }),
      );
    });

    // Direct actions
    bot.command('mute', requireRole('admin'), moderationAction('mute'));
    bot.command('unmute', requireRole('admin'), moderationAction('unmute'));
    bot.command('kick', requireRole('admin'), moderationAction('kick'));
    bot.command('ban', requireRole('admin'), moderationAction('ban'));
    bot.command('unban', requireRole('admin'), moderationAction('unban'));

    // ⏳ Timed mute: /tmute 30m (reply). Auto-unmutes when the duration elapses.
    bot.command('tmute', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('⏳ ردّ على العضو واكتب المدة. مثال: /tmute 30m');
      { const blocked = await punishBlocked(ctx, target); if (blocked) return void ctx.reply(blocked); }
      const secs = parseDuration(ctx.message.text.split(/\s+/)[1]);
      if (!secs) return void ctx.reply('⏳ مدة غير صحيحة. أمثلة: 30m / 2h / 1d');
      const until = Math.floor(Date.now() / 1000) + secs;
      const ok = await muteUser(ctx, target.id, until);
      if (!ok) return void ctx.reply(t('errors.generic'));
      await logAction(ctx.chat.id, 'tmute', ctx.from.id, target.id, `${secs}s`);
      await ctx.reply(`🔇 تم كتم ${mention(target)} لمدة ${formatDuration(secs)}.`);
    });

    // ⏳ Timed ban: /tban 2h (reply). Telegram auto-unbans when it elapses.
    bot.command('tban', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('⏳ ردّ على العضو واكتب المدة. مثال: /tban 2h');
      { const blocked = await punishBlocked(ctx, target); if (blocked) return void ctx.reply(blocked); }
      const secs = parseDuration(ctx.message.text.split(/\s+/)[1]);
      if (!secs) return void ctx.reply('⏳ مدة غير صحيحة. أمثلة: 30m / 2h / 1d');
      const until = Math.floor(Date.now() / 1000) + secs;
      const ok = await ctx.telegram
        .banChatMember(ctx.chat.id, target.id, until)
        .then(() => true)
        .catch(() => false);
      if (!ok) return void ctx.reply(t('errors.generic'));
      await logAction(ctx.chat.id, 'tban', ctx.from.id, target.id, `${secs}s`);
      await ctx.reply(`🚫 تم حظر ${mention(target)} لمدة ${formatDuration(secs)}.`);
    });

    // Promote to Telegram admin (owner/admin only). Optional custom title:
    // /promote اللقب (reply).
    bot.command('promote', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.need_reply'));
      if (await isProtected(ctx, target.id)) return void ctx.reply(t('mod.cant_target_admin'));
      try {
        await ctx.telegram.promoteChatMember(ctx.chat.id, target.id, {
          can_delete_messages: true,
          can_restrict_members: true,
          can_pin_messages: true,
          can_invite_users: true,
          can_manage_video_chats: true,
        });
        // Optional custom admin title (max 16 chars, Telegram limit).
        const title = ctx.message.text.split(' ').slice(1).join(' ').trim().slice(0, 16);
        if (title) {
          await ctx.telegram
            .setChatAdministratorCustomTitle(ctx.chat.id, target.id, title)
            .catch(() => undefined);
        }
        await logAction(ctx.chat.id, 'promote', ctx.from.id, target.id, title || undefined);
        await ctx.reply(
          title
            ? `⬆️ تمت ترقية ${mention(target)} إلى مشرف بلقب «${title}».`
            : t('mod.promoted', { name: mention(target) }),
        );
      } catch {
        await ctx.reply('❌ تعذّرت الترقية. تأكد أن البوت مشرف ولديه صلاحية «إضافة مشرفين».');
      }
    });

    // Demote an admin back to a regular member (owner/admin only).
    bot.command('demote', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.need_reply'));
      if (await isProtected(ctx, target.id)) return void ctx.reply(t('mod.cant_target_admin'));
      try {
        await ctx.telegram.promoteChatMember(ctx.chat.id, target.id, {
          can_change_info: false,
          can_delete_messages: false,
          can_restrict_members: false,
          can_invite_users: false,
          can_pin_messages: false,
          can_promote_members: false,
          can_manage_video_chats: false,
          is_anonymous: false,
        });
        await logAction(ctx.chat.id, 'demote', ctx.from.id, target.id);
        await ctx.reply(`⬇️ تم تنزيل ${mention(target)} من الإشراف.`);
      } catch {
        await ctx.reply('❌ تعذّر التنزيل. لا يمكن تنزيل مشرف رقّاه شخص آخر أو مالك الجروب.');
      }
    });

    // Fully restrict a member — nothing at all can be sent (text included).
    // Optional duration: /restrict 2h (reply).
    bot.command('restrict', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply('🔗 ردّ على العضو الذي تريد تقييده.');
      { const blocked = await punishBlocked(ctx, target); if (blocked) return void ctx.reply(blocked); }
      const secs = parseDuration(ctx.message.text.split(/\s+/)[1]);
      const until = secs ? Math.floor(Date.now() / 1000) + secs : undefined;
      const ok = await ctx.telegram
        .restrictChatMember(ctx.chat.id, target.id, {
          permissions: {
            can_send_messages: false,
            can_send_audios: false,
            can_send_documents: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_video_notes: false,
            can_send_voice_notes: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          },
          until_date: until,
        })
        .then(() => true)
        .catch(() => false);
      if (!ok) return void ctx.reply(t('errors.generic'));
      await logAction(ctx.chat.id, 'restrict', ctx.from.id, target.id, secs ? `${secs}s` : undefined);
      await ctx.reply(
        `🔗 تم تقييد ${mention(target)} تقييداً كاملاً (ممنوع الكتابة أو إرسال أي شيء)${secs ? ` لمدة ${formatDuration(secs)}` : ''}.`,
      );
    });

    // Remove restrictions — restore full sending permissions.
    bot.command('unrestrict', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const target = resolveTarget(ctx);
      if (!target) return void ctx.reply(t('mod.need_reply'));
      const ok = await ctx.telegram
        .restrictChatMember(ctx.chat.id, target.id, { permissions: FULL_SEND_PERMS })
        .then(() => true)
        .catch(() => false);
      if (!ok) return void ctx.reply(t('errors.generic'));
      await logAction(ctx.chat.id, 'unrestrict', ctx.from.id, target.id);
      await ctx.reply(`✅ تم رفع التقييد عن ${mention(target)}.`);
    });

    // Word filters
    bot.command('addfilter', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!word) return void ctx.reply(t('filters.add_usage'));
      await addFilter(ctx.chat.id, word);
      await ctx.reply(t('filters.added', { word }));
    });

    bot.command('delfilter', requireRole('manager'), async (ctx) => {
      const t = ctx.state.t!;
      const word = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!word) return void ctx.reply(t('filters.add_usage'));
      const ok = await deleteFilter(ctx.chat.id, word);
      await ctx.reply(ok ? t('filters.deleted', { word }) : t('filters.list_empty'));
    });

    bot.command('filters', requireRole('admin'), async (ctx) => {
      const t = ctx.state.t!;
      const filters = await listFilters(ctx.chat.id);
      if (!filters.length) return void ctx.reply(t('filters.list_empty'));
      const list = filters.map((f) => `• ${f.word} (${f.action})`).join('\n');
      await ctx.reply(t('filters.list_header', { list }));
    });
  },
};

/** Factory for reply-targeted mute/unmute/kick/ban/unban commands. */
function moderationAction(kind: 'mute' | 'unmute' | 'kick' | 'ban' | 'unban') {
  return async (ctx: BotContext) => {
    const t = ctx.state.t!;
    const target = resolveTarget(ctx);
    if (!target) return void ctx.reply(t('mod.need_reply'));

    // Punishment shield — mute/kick/ban only ever hit plain members; any
    // rank-holder is immune (un-actions unmute/unban are exempt from the shield).
    if (kind === 'mute' || kind === 'kick' || kind === 'ban') {
      const blocked = await punishBlocked(ctx, target);
      if (blocked) return void ctx.reply(blocked);
    }

    let ok = false;
    if (kind === 'mute') ok = await muteUser(ctx, target.id);
    else if (kind === 'unmute') ok = await unmuteUser(ctx, target.id);
    else if (kind === 'kick') ok = await kickUser(ctx, target.id);
    else if (kind === 'ban') ok = await banUser(ctx, target.id);
    else if (kind === 'unban') ok = await unbanUser(ctx, target.id);

    if (ok && ctx.chat && ctx.from) {
      const replyKey: Record<typeof kind, string> = {
        mute: 'mod.muted',
        unmute: 'mod.unmuted',
        kick: 'mod.kicked',
        ban: 'mod.banned',
        unban: 'mod.unbanned',
      };
      await logAction(ctx.chat.id, kind, ctx.from.id, target.id);
      await ctx.reply(t(replyKey[kind], { name: mention(target) }));
    } else if (!ok) {
      // The bot API refused — surface the real reason (usually the bot isn't an
      // admin, or lacks the "ban/restrict members" right).
      await ctx.reply(await botFailureReason(ctx));
    }
  };
}

/** Rank badges for clear rejection messages. */
const ROLE_BADGE: Record<string, string> = {
  founder: '👑 مالك أساسي',
  owner: '⭐ مالك',
  manager: '🔰 مدير',
  admin: '🛡 أدمن',
  vip: '💎 مميز',
  member: '👤 عضو',
};
const roleBadge = (r: string): string => ROLE_BADGE[r] ?? r;
const targetName = (u: { first_name?: string; username?: string }): string =>
  u.first_name || (u.username ? `@${u.username}` : 'الشخص');

/** True if the sender may NOT act on the target: nobody can moderate someone of
 *  equal or higher rank (a Telegram admin counts as 🛡 أدمن, the creator as مالك أساسي). */
async function isProtected(ctx: BotContext, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  const actor: Role = ctx.state.role ?? 'member';
  const targetRole = await resolveUserRole(ctx, userId);
  return !canActOn(actor, targetRole);
}

/**
 * Punishment shield: mute/kick/ban/restrict/tmute/tban can only target plain
 * members. Anyone holding a rank (💎 مميّز and above) is immune — to discipline
 * a rank-holder you must lower their rank first. Returns a rejection message, or
 * null if the target may be punished.
 */
async function punishBlocked(
  ctx: BotContext,
  target: { id: number; first_name?: string; username?: string },
): Promise<string | null> {
  const targetRole = await resolveUserRole(ctx, target.id);
  if (rankOf(targetRole) >= rankOf('vip')) {
    return `🛡 ${targetName(target)} محمي برتبته (${roleBadge(targetRole)}) — أصحاب الرتب ما بينكتموا/بينطردوا/بينحظروا. نزّل رتبته الأول لو لازم.`;
  }
  return null;
}

/**
 * Explain why a Telegram moderation call failed. Almost always it's the BOT's
 * own rights, not the sender's — so say so plainly instead of "حدث خطأ".
 */
async function botFailureReason(ctx: BotContext): Promise<string> {
  if (!ctx.chat) return '⚠️ تعذّر تنفيذ الإجراء.';
  try {
    const meId = ctx.botInfo?.id ?? (await ctx.telegram.getMe()).id;
    const me = (await ctx.telegram.getChatMember(ctx.chat.id, meId)) as {
      status: string;
      can_restrict_members?: boolean;
    };
    if (me.status !== 'administrator' && me.status !== 'creator') {
      return '⚠️ البوت مش مشرف بالجروب. رقّي البوت مشرف وأعطيه صلاحية «حظر الأعضاء» عشان يكتم/يطرد/يحظر.';
    }
    if (me.can_restrict_members === false) {
      return '⚠️ البوت مشرف بس ما عندو صلاحية «حظر الأعضاء». فعّلها من: إعدادات المشرفين ← البوت ← حظر المستخدمين.';
    }
  } catch {
    /* couldn't check — fall through to a general hint */
  }
  return `⚠️ تعذّر تنفيذ الإجراء. غالباً الهدف مشرف في تيليجرام أعلى من البوت — البوت ما بيقدر يطبّق على مشرف مرتبته أعلى منه.`;
}
