import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { synthesize, ttsReady } from '../../services/tts';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:tts');

// Reply-triggers: «نطق النص» / reply «اقرأ» to a text message, etc. Avoids the
// bare word «صوت» (already a music alias). Optional trailing text is captured.
const TRIGGER = /^(?:نطق|انطق|انطقها|اقرأ|اقرا|اقراها|تكلم|قولها|تعليق صوتي|فويس اوفر|حوله صوت|صوتها)(?:\s+([\s\S]+))?$/;

/** Pick the text to speak: the trigger's own argument, else the replied
 *  message's text/caption. Exported for testing. */
export function pickTtsText(arg: string | undefined, repliedText: string | undefined): string | null {
  const a = (arg ?? '').trim();
  if (a) return a;
  const r = (repliedText ?? '').trim();
  return r || null;
}

async function speak(ctx: BotContext, text: string): Promise<void> {
  if (!ctx.chat) return;
  if (!ttsReady()) {
    const owner = ctx.from && isBotOwner(ctx.from.id);
    await ctx
      .reply(
        owner
          ? '🎙 خدمة تحويل النص لصوت مش مفعّلة. فعّل <code>TTS_ENABLED=true</code> (Edge مجاني بلا مفتاح).'
          : '🎙 خدمة التعليق الصوتي مش مفعّلة حالياً.',
      )
      .catch(() => undefined);
    return;
  }

  const status = await ctx.reply('🎙 جاري تحويل النص لصوت... ⏳').catch(() => undefined);
  const statusId = (status as { message_id?: number } | undefined)?.message_id;
  await ctx.sendChatAction('record_voice').catch(() => undefined);

  const result = await synthesize(text);
  const clearStatus = () => (statusId ? ctx.telegram.deleteMessage(ctx.chat!.id, statusId).catch(() => undefined) : undefined);

  if ('error' in result) {
    const MSG: Record<string, string> = {
      disabled: '🎙 خدمة التعليق الصوتي مش مفعّلة.',
      empty: '📝 اكتب نص عشان أحوّله لصوت.',
      toolong: '📏 النص طويل كتير، قصّره شوي وجرّب.',
      nokey: '🎙 مفتاح الصوت غير مضبوط.',
      api: '⚠️ تعذّر توليد الصوت الآن، حاول مرة ثانية.',
    };
    const text2 = MSG[result.error] || MSG.api;
    if (statusId) await ctx.telegram.editMessageText(ctx.chat.id, statusId, undefined, text2, { parse_mode: 'HTML' }).catch(() => undefined);
    else await ctx.reply(text2, { parse_mode: 'HTML' }).catch(() => undefined);
    return;
  }

  await clearStatus();
  // Send as an audio file (mp3) so it's downloadable for editing/reels.
  await ctx
    .replyWithAudio(Input.fromBuffer(result.buffer, `voiceover.${result.ext}`), {
      title: 'تعليق صوتي',
      performer: '🎙 Voice-over',
      caption: '🎙 تفضّل التعليق الصوتي',
    })
    .catch(async (err) => {
      log.warn({ err }, 'send audio failed — trying voice');
      await ctx.replyWithVoice(Input.fromBuffer(result.buffer, `voiceover.${result.ext}`)).catch(() => undefined);
    });
}

/**
 * Text-to-speech: turn a script into a natural voice-over. «نطق <النص>», or
 * reply «اقرأ» / «نطق» to a text message. Free neural voices via Edge (no key),
 * or ElevenLabs when a key is set. Opt-in (TTS_ENABLED).
 */
export const ttsPlugin: Plugin = {
  name: 'tts',
  description: 'Turn text into a natural voice-over (text-to-speech)',
  commands: [{ command: 'tts', description: '🎙 حوّل نص لصوت طبيعي: نطق النص' }],

  register(bot: Telegraf<BotContext>) {
    bot.command(['tts', 'say'], async (ctx) => {
      const arg = ctx.message.text.split(/\s+/).slice(1).join(' ');
      const replied = (ctx.message as { reply_to_message?: { text?: string; caption?: string } }).reply_to_message;
      const text = pickTtsText(arg, replied?.text || replied?.caption);
      if (!text) {
        await ctx.reply('🎙 اكتب: <code>نطق النص هنا</code>\nأو ردّ على رسالة نصية بكلمة «اقرأ».', { parse_mode: 'HTML' }).catch(() => undefined);
        return;
      }
      await speak(ctx, text);
    });

    bot.hears(TRIGGER, async (ctx, next) => {
      const arg = ctx.match[1];
      const replied = (ctx.message as { reply_to_message?: { text?: string; caption?: string } }).reply_to_message;
      const text = pickTtsText(arg, replied?.text || replied?.caption);
      // These are common words — only act when there's actual text to speak.
      if (!text) return next();
      await speak(ctx, text);
    });
  },
};
