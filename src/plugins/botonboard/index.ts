import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { makeTranslator, type Var } from '../../locales';
import { getLocale } from '../../services/settings.service';
import { env } from '../../config/env';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:botonboard');

const IN_GROUP = new Set(['member', 'administrator', 'restricted', 'creator']);
const WELCOME_DEDUPE_MS = 24 * 60 * 60 * 1000; // don't re-welcome within 24h

type T = (key: string, vars?: Record<string, Var>) => string;

type BotMember = {
  status: string;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_pin_messages?: boolean;
  can_invite_users?: boolean;
};

/** Classify a my_chat_member status change into the events we care about. */
export function classifyTransition(
  oldStatus: string,
  newStatus: string,
): { added: boolean; promoted: boolean; removed: boolean } {
  const wasIn = IN_GROUP.has(oldStatus);
  const isIn = newStatus === 'member' || newStatus === 'administrator';
  return {
    added: isIn && !wasIn,
    promoted: oldStatus === 'member' && newStatus === 'administrator',
    removed: wasIn && (newStatus === 'left' || newStatus === 'kicked'),
  };
}

/** The list of missing admin permissions (translated), or [] when complete /
 *  not an admin. */
export function missingPerms(me: BotMember, t: T): string[] {
  if (me.status !== 'administrator' && me.status !== 'creator') return [];
  const miss: string[] = [];
  if (!me.can_delete_messages) miss.push(t('onboard.perm.delete'));
  if (!me.can_restrict_members) miss.push(t('onboard.perm.restrict'));
  if (!me.can_pin_messages) miss.push(t('onboard.perm.pin'));
  if (!me.can_invite_users) miss.push(t('onboard.perm.invite'));
  return miss;
}

const keyboard = (t: T) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(t('onboard.btn.commands'), 'onb:cmds'),
      Markup.button.callback(t('onboard.btn.settings'), 'onb:settings'),
      Markup.button.callback(t('onboard.btn.support'), 'onb:support'),
    ],
  ]);

/**
 * Bot onboarding: greet the group when the bot is added, tell the admin what
 * permissions are missing (or to promote it), and confirm once it becomes admin.
 * Separate from the member-welcome plugin (which greets human joiners).
 */
export const botOnboardPlugin: Plugin = {
  name: 'botonboard',
  description: 'Greets the group when the bot is added / promoted, flags missing perms',

  register(bot: Telegraf<BotContext>) {
    bot.on('my_chat_member', async (ctx) => {
      const chat = ctx.chat;
      if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
      const upd = ctx.myChatMember;
      const oldStatus = upd.old_chat_member?.status ?? 'left';
      const newStatus = upd.new_chat_member?.status ?? 'left';

      const { added, promoted, removed } = classifyTransition(oldStatus, newStatus);

      // Removal → analytics only, never a message.
      if (removed) {
        log.info({ chatId: chat.id, title: (chat as { title?: string }).title }, 'bot removed from group');
        return;
      }
      if (!added && !promoted) return;

      const t: T = ctx.state.t ?? makeTranslator(await getLocale(chat.id).catch(() => env.DEFAULT_LANGUAGE));
      const title = (chat as { title?: string }).title || '';

      // Fresh permission read.
      let me: BotMember = upd.new_chat_member as BotMember;
      try {
        const meId = ctx.botInfo?.id ?? (await ctx.telegram.getMe()).id;
        me = (await ctx.telegram.getChatMember(chat.id, meId)) as BotMember;
      } catch (err) {
        log.debug({ err }, 'getChatMember(self) failed; using update payload');
      }
      const isAdmin = me.status === 'administrator' || me.status === 'creator';
      const miss = missingPerms(me, t);

      const lines: string[] = [];
      if (promoted) {
        lines.push(t('onboard.promoted'));
      } else {
        lines.push(t('onboard.welcome', { title }));
        if (!isAdmin) lines.push(t('onboard.need_admin'));
      }
      if (isAdmin) {
        lines.push(miss.length ? t('onboard.perms_missing', { list: miss.map((p) => `• ${p}`).join('\n') }) : t('onboard.perms_ok'));
      }

      // Dedupe the initial welcome within 24h (a re-add same day shouldn't spam).
      if (added) {
        const chatRow = await prisma.chat.findUnique({ where: { id: BigInt(chat.id) } }).catch(() => null);
        const last = chatRow?.botWelcomedAt ? new Date(chatRow.botWelcomedAt).getTime() : 0;
        if (last && Date.now() - last < WELCOME_DEDUPE_MS) {
          log.debug({ chatId: chat.id }, 'bot welcome skipped (within 24h)');
          return;
        }
      }

      try {
        await ctx.telegram.sendMessage(chat.id, lines.join('\n'), keyboard(t));
        if (added) {
          await prisma.chat
            .update({ where: { id: BigInt(chat.id) }, data: { botWelcomedAt: new Date() } })
            .catch(() => undefined);
        }
      } catch (err) {
        // Usually the bot can't post yet (restricted / no rights) — log, never crash.
        log.warn({ err, chatId: chat.id }, 'could not send onboarding message');
      }
    });

    // Button hints (short alerts, translated).
    bot.action('onb:cmds', (ctx) => ctx.answerCbQuery((ctx.state.t ?? makeTranslator('ar'))('onboard.cmds_hint'), { show_alert: true }).catch(() => undefined));
    bot.action('onb:settings', (ctx) => ctx.answerCbQuery((ctx.state.t ?? makeTranslator('ar'))('onboard.settings_hint'), { show_alert: true }).catch(() => undefined));
    bot.action('onb:support', (ctx) => ctx.answerCbQuery((ctx.state.t ?? makeTranslator('ar'))('onboard.support_hint'), { show_alert: true }).catch(() => undefined));
  },
};
