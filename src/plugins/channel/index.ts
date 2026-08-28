import type { Telegraf } from 'telegraf';
import type { TelegramEmoji } from 'telegraf/types';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { matchAlias } from '../aliases';
import { isChannelReactOn, setChannelReact } from '../../services/channel.service';
import { env } from '../../config/env';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:channel');

// Content/tool commands that make sense inside a CHANNEL (no group state, no
// per-user identity, no moderation). Group/economy/game/moderation commands are
// intentionally NOT bridged, so they don't post confusing "group only" replies.
const SAFE_CHANNEL_COMMANDS = new Set([
  'decorate', 'quote', 'fact', 'joke', 'tr', 'calc', 'convert', 'currency', 'crypto',
  'qr', 'password', 'hijri', 'choose', '8ball', 'rate', 'short', 'weather', 'time',
  'date', 'day', 'ayah', 'hadith', 'thikr', 'athkar', 'sabah', 'masa', 'ayahtafsir',
  'tasbeeh', 'prayer', 'truth', 'dare', 'wyr', 'riddle', 'fortune', 'compliment',
  'bio', 'rules', 'help', 'menu', 'id', 'dev', 'story', 'find', 'flip', 'dice',
  'soulmate', 'persona',
]);

// Telegram-approved reaction emoji (a subset that's broadly enabled).
const REACTIONS: TelegramEmoji[] = ['👍', '❤', '🔥', '🥰', '👏', '😁', '🎉', '🤩', '🙏', '💯'];

// Toggle phrases an admin posts IN the channel.
const REACT_ON_RE = /^(?:تفاعل|فعل التفاعل|شغل التفاعل|تفعيل التفاعل)$/;
const REACT_OFF_RE = /^(?:وقف التفاعل|ايقاف التفاعل|إيقاف التفاعل|بطل التفاعل|الغاء التفاعل)$/;

/** Resolve a channel post's text to a "/command args" + bare command name, or
 *  null. Accepts a real "/cmd" or an Arabic alias (via matchAlias). */
export function channelCommand(text: string): { cmd: string; full: string } | null {
  const t = (text || '').trim();
  if (!t) return null;
  let full: string;
  if (t.startsWith('/')) full = t;
  else {
    const rewritten = matchAlias(t);
    if (!rewritten) return null;
    full = rewritten;
  }
  const cmd = full.slice(1).split(/\s+/)[0].split('@')[0].toLowerCase();
  return cmd ? { cmd, full } : null;
}

/**
 * Make the bot usable inside CHANNELS: it reacts to new posts (opt-in per
 * channel) and answers a curated set of content/tool commands. Channel posts
 * arrive as `channel_post` (not `message`) with no `from`, so this bridges a
 * safe command into the normal pipeline by re-dispatching it as a synthetic
 * message. Scheduled daily posts (آية/أذكار/…) are deliberately NOT added here.
 */
export const channelPlugin: Plugin = {
  name: 'channel',
  description: 'Channel support: auto-react to posts + answer content commands',

  register(bot: Telegraf<BotContext>) {
    bot.on('channel_post', async (ctx, next) => {
      const chat = ctx.chat;
      const post = ctx.channelPost as
        | { message_id: number; date: number; text?: string; caption?: string; chat: unknown }
        | undefined;
      if (!chat || chat.type !== 'channel' || !post) return next();

      const text = (post.text || post.caption || '').trim();

      // 1) Auto-react toggle (posted by a channel admin).
      if (REACT_ON_RE.test(text)) {
        await setChannelReact(chat.id, true).catch(() => undefined);
        await ctx.reply('✅ تم تفعيل التفاعل التلقائي مع المنشورات في هذه القناة.').catch(() => undefined);
        return next();
      }
      if (REACT_OFF_RE.test(text)) {
        await setChannelReact(chat.id, false).catch(() => undefined);
        await ctx.reply('⛔️ تم إيقاف التفاعل التلقائي في هذه القناة.').catch(() => undefined);
        return next();
      }

      const detected = channelCommand(text);

      // 2) Auto-react to normal posts (not commands, not the storage channel).
      if (!detected && chat.id !== env.MUSIC_STORAGE_CHANNEL_ID) {
        if (await isChannelReactOn(chat.id).catch(() => false)) {
          const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
          await ctx.telegram
            .setMessageReaction(chat.id, post.message_id, [{ type: 'emoji', emoji }])
            .catch((err) => log.debug({ err, chatId: chat.id }, 'setMessageReaction failed'));
        }
      }

      // 3) Command bridge: re-dispatch a safe command as a synthetic message so
      //    all existing handlers run (with a channel-derived pseudo user).
      if (detected && SAFE_CHANNEL_COMMANDS.has(detected.cmd)) {
        const fake = {
          update_id: ctx.update.update_id,
          message: {
            message_id: post.message_id,
            date: post.date,
            chat: post.chat,
            from: { id: Math.abs(Number(chat.id)) || 1, is_bot: false, first_name: 'Channel' },
            text: detected.full,
            entities: [{ type: 'bot_command', offset: 0, length: `/${detected.cmd}`.length }],
          },
        };
        await bot.handleUpdate(fake as never).catch((err) => log.warn({ err, cmd: detected.cmd }, 'channel command bridge failed'));
        return next();
      }

      return next();
    });
  },
};
