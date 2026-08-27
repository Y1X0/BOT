import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:story');

// The headless streamer service (music-bot/) owns the assistant user account,
// the ONLY thing that can read Telegram stories (the Bot API cannot). Same
// config as the music plugin.
const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

interface StoryResult {
  ok?: boolean;
  error?: string;
  detail?: string;
  storage_chat_id?: number;
  message_id?: number;
  kind?: string;
}

/** A story reference: the poster (a @username or a numeric id) + the story id,
 *  plus a human label for captions/logs. */
export interface StoryRef {
  peer: string | number;
  storyId: number;
  label: string;
}

/**
 * Extract the username + story id from a Telegram story link, or null.
 * Accepts: https://t.me/<username>/s/<id>  (scheme optional; trailing path/query
 * ignored). Usernames are 5–32 chars, must start with a letter.
 */
export function parseStoryLink(text: string): { username: string; storyId: number } | null {
  if (!text) return null;
  const m = text.match(/(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/s\/(\d+)/i);
  if (!m) return null;
  const storyId = parseInt(m[2], 10);
  if (!storyId) return null;
  return { username: m[1], storyId };
}

/** A Telegram-native shared story: Message.story = { chat, id }. Present when a
 *  user shares/forwards a story into the chat — works even for posters with NO
 *  username (we get the numeric chat id instead). Returns a StoryRef or null. */
type SharedStory = { id?: number; chat?: { id?: number; username?: string; first_name?: string; title?: string } };

export function storyFromMessage(msg: unknown): StoryRef | null {
  const st = (msg as { story?: SharedStory } | undefined)?.story;
  if (!st || !st.id || !st.chat) return null;
  const chat = st.chat;
  const peer: string | number | undefined = chat.username || chat.id;
  if (peer == null) return null;
  const label = chat.username ? `@${chat.username}` : chat.first_name || chat.title || String(chat.id);
  return { peer, storyId: st.id, label };
}

async function callStreamer(path: string, body: Record<string, unknown>): Promise<StoryResult | null> {
  if (!STREAMER_URL) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000); // stories can be a big video
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as StoryResult;
  } catch (err) {
    log.warn({ err, path }, 'streamer call failed');
    return { ok: false, error: 'unreachable' };
  }
}

const ERRORS: Record<string, string> = {
  no_storage: '⚠️ الميزة تحتاج قناة تخزين. اضبط <code>MUSIC_STORAGE_CHANNEL_ID</code> (نفس قناة الأرشيف).',
  baduser: '❌ ما قدر يوصل لصاحب الستوري. لو ما عندو يوزر، شارك الستوري نفسها للبوت بدل الرابط.',
  private: '🔒 الستوري خاصة أو محمية — الحساب المساعد ما بيقدر يشوفها.',
  notfound: '⌛ الستوري غير موجودة أو انتهت (تنتهي بعد 24 ساعة).',
  starting: '⏳ الخدمة قيد التشغيل، جرّب بعد لحظات.',
  failed: '⚠️ تعذّر تنزيل الستوري، حاول مرة ثانية.',
  unreachable: '🎧 خدمة الحساب المساعد غير متصلة الآن.',
  bad_response: '⚠️ رد غير متوقّع من الخدمة.',
  unauthorized: '⚠️ خطأ مصادقة مع خدمة البث.',
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NOT_CONFIGURED =
  '📥 <b>خدمة تنزيل الستوري مش مفعّلة.</b>\nلازم يشتغل الحساب المساعد (music-bot) ويُضبط <code>STREAMER_URL</code> + قناة تخزين.';

async function handleStory(ctx: BotContext, ref: StoryRef): Promise<void> {
  if (!ctx.chat) return;
  if (!STREAMER_URL) {
    await ctx.reply(NOT_CONFIGURED, { parse_mode: 'HTML' }).catch(() => undefined);
    return;
  }
  const status = await ctx.reply('📥 جاري تنزيل الستوري...').catch(() => undefined);
  const statusId = (status as { message_id?: number } | undefined)?.message_id;
  await ctx.sendChatAction('upload_video').catch(() => undefined);

  const r = await callStreamer('/story', { peer: ref.peer, story_id: ref.storyId });

  const clearStatus = () => (statusId ? ctx.telegram.deleteMessage(ctx.chat!.id, statusId).catch(() => undefined) : undefined);
  const failWith = (text: string) =>
    statusId
      ? ctx.telegram.editMessageText(ctx.chat!.id, statusId, undefined, text, { parse_mode: 'HTML' }).catch(() => undefined)
      : ctx.reply(text, { parse_mode: 'HTML' }).catch(() => undefined);

  if (!r || !r.ok) {
    const key = r?.error || 'unreachable';
    await failWith(ERRORS[key] || ERRORS.failed);
    return;
  }
  if (!r.storage_chat_id || !r.message_id) {
    await failWith(ERRORS.failed);
    return;
  }

  try {
    await ctx.telegram.copyMessage(ctx.chat.id, r.storage_chat_id, r.message_id, {
      caption: `📥 ستوري <b>${escapeHtml(ref.label)}</b>`,
      parse_mode: 'HTML',
    });
    await clearStatus();
  } catch (err) {
    log.warn({ err }, 'copyMessage of story failed');
    await failWith('⚠️ نزّلت الستوري بس تعذّر إرسالها هنا (تأكد أن البوت مشرف في قناة التخزين).');
  }
}

/**
 * Story downloader: paste a Telegram story link (t.me/<user>/s/<id>) and the bot
 * fetches it through the assistant user account and re-sends it here. Bots can't
 * read stories via the Bot API, so this always routes through the streamer.
 */
export const storyPlugin: Plugin = {
  name: 'story',
  description: 'Download a Telegram story from its link (via the assistant)',
  commands: [{ command: 'story', description: '📥 نزّل ستوري تليجرام: /story <رابط>' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('story', async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      // 1) A shared story — on the replied message (works without a username).
      const shared = storyFromMessage(replied);
      if (shared) return void (await handleStory(ctx, shared));
      // 2) A link — from the command args or the replied text/caption.
      const fromArg = ctx.message.text.split(/\s+/).slice(1).join(' ');
      const rep = replied as { text?: string; caption?: string } | undefined;
      const text = fromArg || rep?.text || rep?.caption || '';
      const parsed = parseStoryLink(text);
      if (parsed) return void (await handleStory(ctx, { peer: parsed.username, storyId: parsed.storyId, label: `@${parsed.username}` }));
      await ctx
        .reply(
          '📥 نزّل ستوري تليجرام:\n' +
            '• لو صاحبها عندو يوزر: <code>/story https://t.me/username/s/12</code>\n' +
            '• لو ما عندو يوزر: <b>شارك الستوري نفسها للبوت</b> ثم ردّ عليها بكلمة «ستوري».',
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
    });

    // A user shared a story into the chat, then replied «ستوري» — but the alias
    // rewrite only fires on text messages, so also catch a bare shared story the
    // user replies to. Handled above via /story. Here we auto-catch pasted links.
    bot.on(message('text'), async (ctx, next) => {
      if (ctx.message.text.startsWith('/')) return next();
      // A reply to a shared story with the word «ستوري» / «نزل».
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      const shared = storyFromMessage(replied);
      if (shared && /^(?:ستوري|نزل|حمل|حفظ)\b/i.test(ctx.message.text.trim())) {
        await handleStory(ctx, shared);
        return;
      }
      // A pasted story link (t.me/<user>/s/<id>).
      const parsed = parseStoryLink(ctx.message.text);
      if (!parsed) return next();
      await handleStory(ctx, { peer: parsed.username, storyId: parsed.storyId, label: `@${parsed.username}` });
      // consumed — a story link isn't a normal message
    });
  },
};
