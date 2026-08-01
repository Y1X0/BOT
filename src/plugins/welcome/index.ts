import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { getSettings } from '../../services/settings.service';
import { displayName } from '../../utils/format';
import { muteUser, unmuteUser, kickUser } from '../../utils/moderation-actions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:welcome');

/** Pending captcha challenges keyed by chatId:userId → timeout handle. */
const pendingCaptcha = new Map<string, NodeJS.Timeout>();

export const welcomePlugin: Plugin = {
  name: 'welcome',
  description: 'Welcome/farewell messages with optional CAPTCHA verification',

  register(bot: Telegraf<BotContext>) {
    // New members joining.
    bot.on('new_chat_members', async (ctx) => {
      const settings = ctx.state.settings ?? (await getSettings(ctx.chat.id));
      if (!settings) return;
      const t = ctx.state.t!;

      for (const member of ctx.message.new_chat_members) {
        if (member.is_bot) continue;
        const name = displayName(member);

        if (settings.captchaEnabled) {
          await startCaptcha(ctx, member.id, name, settings.captchaTimeoutSec, t);
          continue;
        }

        if (settings.welcomeEnabled) {
          await sendWelcome(ctx, settings, member, name, t);
        }
      }
    });

    // Members leaving.
    bot.on('left_chat_member', async (ctx) => {
      const settings = ctx.state.settings ?? (await getSettings(ctx.chat.id));
      if (!settings?.farewellEnabled) return;
      const t = ctx.state.t!;
      const member = ctx.message.left_chat_member;
      if (member.is_bot) return;
      const text = settings.farewellMessage
        ? interpolate(settings.farewellMessage, member, ctx.chat)
        : t('farewell.default', { name: displayName(member) });
      await ctx.reply(text).catch(() => undefined);
    });

    // CAPTCHA button press.
    bot.action(/^captcha:(\d+)$/, async (ctx) => {
      const expectedUserId = Number(ctx.match[1]);
      if (ctx.from?.id !== expectedUserId) {
        await ctx.answerCbQuery('⛔️').catch(() => undefined);
        return;
      }
      const key = `${ctx.chat!.id}:${expectedUserId}`;
      const timer = pendingCaptcha.get(key);
      if (timer) {
        clearTimeout(timer);
        pendingCaptcha.delete(key);
      }
      await unmuteUser(ctx, expectedUserId);
      const t = ctx.state.t!;
      await ctx.answerCbQuery('✅').catch(() => undefined);
      await ctx.editMessageText(
        t('welcome.captcha_passed', { name: displayName(ctx.from) }),
      ).catch(() => undefined);
    });
  },
};

async function startCaptcha(
  ctx: BotContext,
  userId: number,
  name: string,
  timeoutSec: number,
  t: (k: string, v?: Record<string, string | number>) => string,
): Promise<void> {
  // Restrict the new member until they verify.
  await muteUser(ctx, userId);

  const sent = await ctx
    .reply(
      t('welcome.captcha', { name, seconds: timeoutSec }),
      Markup.inlineKeyboard([
        Markup.button.callback(t('welcome.captcha_button'), `captcha:${userId}`),
      ]),
    )
    .catch(() => undefined);

  const key = `${ctx.chat!.id}:${userId}`;
  const timer = setTimeout(async () => {
    pendingCaptcha.delete(key);
    // Failed to verify in time → kick.
    await kickUser(ctx, userId);
    if (sent) {
      await ctx.telegram
        .editMessageText(ctx.chat!.id, sent.message_id, undefined, t('welcome.captcha_failed'))
        .catch(() => undefined);
    }
    log.info({ chatId: ctx.chat!.id, userId }, 'CAPTCHA timeout — user kicked');
  }, timeoutSec * 1000);
  timer.unref?.();
  pendingCaptcha.set(key, timer);
}

async function sendWelcome(
  ctx: BotContext,
  settings: { welcomeMessage: string | null; welcomeImageUrl: string | null },
  member: { id: number; first_name?: string; username?: string },
  name: string,
  t: (k: string, v?: Record<string, string | number>) => string,
): Promise<void> {
  const text = settings.welcomeMessage
    ? interpolate(settings.welcomeMessage, member, ctx.chat)
    : t('welcome.default', { name, title: ctx.chat?.type === 'private' ? '' : (ctx.chat as { title?: string })?.title ?? '' });

  if (settings.welcomeImageUrl) {
    await ctx
      .replyWithPhoto(settings.welcomeImageUrl, { caption: text })
      .catch(() => ctx.reply(text).catch(() => undefined));
  } else {
    await ctx.reply(text).catch(() => undefined);
  }
}

/** Replace {name} {title} placeholders in a custom template. */
function interpolate(
  template: string,
  member: { first_name?: string; username?: string },
  chat: unknown,
): string {
  const title = (chat as { title?: string })?.title ?? '';
  return template
    .replaceAll('{name}', displayName(member))
    .replaceAll('{title}', title);
}
