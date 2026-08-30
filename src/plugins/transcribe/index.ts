import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { transcribeFromUrl, transcribeReady } from '../../services/transcribe';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:transcribe');

// An audio-bearing message the user replied to. Telegram voice notes are OGG,
// audio files vary, video notes are MP4 — the Whisper endpoints accept all.
type AudioMsg = {
  voice?: { file_id: string };
  audio?: { file_id: string; file_name?: string };
  video_note?: { file_id: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
};

/** Extract a transcribable audio file (id + a filename with the right extension)
 *  from a message, or null. Exported for testing. */
export function audioFromMessage(msg: unknown): { fileId: string; filename: string } | null {
  const m = msg as AudioMsg | undefined;
  if (!m) return null;
  if (m.voice) return { fileId: m.voice.file_id, filename: 'voice.ogg' };
  if (m.audio) return { fileId: m.audio.file_id, filename: m.audio.file_name || 'audio.mp3' };
  if (m.video_note) return { fileId: m.video_note.file_id, filename: 'note.mp4' };
  if (m.document && /^audio\//i.test(m.document.mime_type || '')) {
    return { fileId: m.document.file_id, filename: m.document.file_name || 'audio.ogg' };
  }
  return null;
}

// Reply-triggers: reply to a voice/audio with one of these to transcribe it.
const TRIGGER = /^(?:نص|تفريغ|تفريغ صوتي|فرّغ|فرغ|اكتب|اكتب الصوت|حوله نص|حول لنص|فك الصوت|كتابه)$/;

const HEADER = '📝 <b>تفريغ الصوت</b>\n✦ ┈┈┈┈┈┈┈┈ ✦\n';

async function handle(ctx: BotContext, replied: unknown): Promise<void> {
  if (!ctx.chat) return;
  const audio = audioFromMessage(replied);
  if (!audio) {
    await ctx.reply('🎙 ردّ على <b>رسالة صوتية</b> أو تسجيل بكلمة «نص» لتحويله لنص.').catch(() => undefined);
    return;
  }
  if (!transcribeReady()) {
    const owner = ctx.from && isBotOwner(ctx.from.id);
    await ctx
      .reply(
        owner
          ? '🎙 خدمة التفريغ مش مفعّلة. فعّل <code>TRANSCRIBE_ENABLED=true</code> وأضف <code>TRANSCRIBE_API_KEY</code> (مفتاح Groq مجاني من console.groq.com).'
          : '🎙 خدمة تحويل الصوت لنص مش مفعّلة حالياً.',
      )
      .catch(() => undefined);
    return;
  }

  const status = await ctx.reply('🎙 جاري تفريغ الصوت... ⏳').catch(() => undefined);
  const statusId = (status as { message_id?: number } | undefined)?.message_id;
  await ctx.sendChatAction('typing').catch(() => undefined);

  let link: string;
  try {
    const l = await ctx.telegram.getFileLink(audio.fileId);
    link = l.toString();
  } catch (err) {
    log.warn({ err }, 'getFileLink failed');
    if (statusId) await ctx.telegram.editMessageText(ctx.chat.id, statusId, undefined, '⚠️ تعذّر جلب الملف الصوتي.').catch(() => undefined);
    return;
  }

  const result = await transcribeFromUrl(link, audio.filename);

  const edit = (text: string, extra?: object) =>
    statusId
      ? ctx.telegram.editMessageText(ctx.chat!.id, statusId, undefined, text, extra as never).catch(() => undefined)
      : ctx.reply(text, extra as never).catch(() => undefined);

  if ('error' in result) {
    const MSG: Record<string, string> = {
      disabled: '🎙 خدمة التفريغ مش مفعّلة.',
      nokey: '🎙 مفتاح التفريغ غير مضبوط.',
      toolarge: '📦 الملف الصوتي كبير جداً، جرّب تسجيل أقصر.',
      download: '⚠️ تعذّر تنزيل الملف الصوتي.',
      api: '⚠️ تعذّر التفريغ الآن، حاول مرة ثانية.',
      empty: '🤔 ما قدرت أفهم كلام واضح بالتسجيل.',
    };
    await edit(MSG[result.error] || MSG.api);
    return;
  }

  const text = result.text;
  // Long transcripts exceed Telegram's 4096-char message cap → send as a file.
  if (text.length > 3800) {
    if (statusId) await ctx.telegram.deleteMessage(ctx.chat.id, statusId).catch(() => undefined);
    await ctx
      .replyWithDocument(Input.fromBuffer(Buffer.from(text, 'utf8'), 'transcript.txt'), {
        caption: '📝 تفريغ الصوت (نص طويل — مرفق كملف).',
      })
      .catch(() => undefined);
    return;
  }
  await edit(HEADER + escapeHtml(text), { parse_mode: 'HTML' });
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Speech-to-text: reply «نص» (or تفريغ / فرّغ / اكتب …) to a voice message,
 * audio file or video note, and the bot transcribes it to text via a hosted
 * Whisper model. Opt-in (TRANSCRIBE_ENABLED + TRANSCRIBE_API_KEY).
 */
export const transcribePlugin: Plugin = {
  name: 'transcribe',
  description: 'Transcribe a replied voice/audio message to text (Whisper)',
  commands: [{ command: 'transcribe', description: '📝 حوّل تسجيل صوتي لنص (بالرد)' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('transcribe', async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      await handle(ctx, replied);
    });

    // Reply «نص» / «تفريغ» / … to a voice/audio message.
    bot.hears(TRIGGER, async (ctx, next) => {
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      // Only act when replying to an actual audio message — otherwise these are
      // common words and should pass through to normal chat.
      if (!replied || !audioFromMessage(replied)) return next();
      await handle(ctx, replied);
    });
  },
};
