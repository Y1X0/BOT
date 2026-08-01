import type { BotContext } from '../core/context';
import { createLogger } from '../core/logger';

const log = createLogger('mod-actions');

/**
 * Thin, defensive wrappers around Telegram moderation APIs.
 * Each returns a boolean success flag and never throws, so higher-level
 * handlers can decide how to report failure to the group.
 */

export async function muteUser(
  ctx: BotContext,
  userId: number,
  untilDateSec?: number,
): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
      permissions: {
        can_send_messages: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      },
      until_date: untilDateSec,
    });
    return true;
  } catch (err) {
    log.warn({ err, userId }, 'muteUser failed');
    return false;
  }
}

export async function unmuteUser(ctx: BotContext, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
      permissions: {
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
      },
    });
    return true;
  } catch (err) {
    log.warn({ err, userId }, 'unmuteUser failed');
    return false;
  }
}

/** Kick = ban then immediately unban so the user can rejoin. */
export async function kickUser(ctx: BotContext, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    await ctx.telegram.banChatMember(ctx.chat.id, userId);
    await ctx.telegram.unbanChatMember(ctx.chat.id, userId);
    return true;
  } catch (err) {
    log.warn({ err, userId }, 'kickUser failed');
    return false;
  }
}

export async function banUser(ctx: BotContext, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    await ctx.telegram.banChatMember(ctx.chat.id, userId);
    return true;
  } catch (err) {
    log.warn({ err, userId }, 'banUser failed');
    return false;
  }
}

export async function unbanUser(ctx: BotContext, userId: number): Promise<boolean> {
  if (!ctx.chat) return false;
  try {
    await ctx.telegram.unbanChatMember(ctx.chat.id, userId, { only_if_banned: true });
    return true;
  } catch (err) {
    log.warn({ err, userId }, 'unbanUser failed');
    return false;
  }
}

export async function deleteMessage(ctx: BotContext): Promise<boolean> {
  try {
    await ctx.deleteMessage();
    return true;
  } catch {
    return false;
  }
}

/** Apply the configured escalation action for a member over the warning limit. */
export async function applyWarnAction(
  ctx: BotContext,
  userId: number,
  action: string,
): Promise<'mute' | 'kick' | 'ban' | 'none'> {
  if (action === 'ban') return (await banUser(ctx, userId)) ? 'ban' : 'none';
  if (action === 'kick') return (await kickUser(ctx, userId)) ? 'kick' : 'none';
  // default: mute for 1 hour
  const oneHour = Math.floor(Date.now() / 1000) + 3600;
  return (await muteUser(ctx, userId, oneHour)) ? 'mute' : 'none';
}
