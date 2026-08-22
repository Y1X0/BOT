import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { requireRole } from '../../utils/permissions';
import { indexAudio, archiveCount } from '../../services/archive';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:musicarchive');

const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

/** POST to the streamer's control API. Returns the parsed body, or null on error. */
async function callStreamer(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!STREAMER_URL) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err, path }, 'streamer call failed');
    return { ok: false, error: 'unreachable' };
  }
}

type TgAudio = { file_id: string; title?: string; performer?: string; file_name?: string; duration?: number };
type TgDocument = { file_id: string; file_name?: string; mime_type?: string };

const AUDIO_EXT = /\.(mp3|m4a|flac|wav|ogg|opus|aac|wma|alac|aiff?)$/i;

/** Is this document actually an audio file (music channels often upload MP3s as
 *  documents, not as Telegram's native "audio" type)? */
function isAudioDoc(doc: TgDocument | undefined): doc is TgDocument {
  if (!doc?.file_id) return false;
  const mime = (doc.mime_type || '').toLowerCase();
  return mime.startsWith('audio/') || AUDIO_EXT.test(doc.file_name || '');
}

/** Auto-index audio posted to the storage channel, and expose the archive size. */
export const musicArchivePlugin: Plugin = {
  name: 'musicarchive',
  description: 'Index audio from the storage channel into the archive',
  commands: [
    { command: 'archivecount', description: '🗂 عدد الأغاني بالأرشيف (مالك)', staffOnly: true },
    { command: 'import', description: '📥 استيراد أغاني من قناة للأرشيف (مالك)', staffOnly: true },
    { command: 'importstop', description: '🛑 إيقاف الاستيراد (مالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // Auto-index audio from channels. By default this covers EVERY channel the
    // bot is admin in (the bot only receives channel_post from those), so you
    // can post songs to any of your channels and they all feed one archive. Set
    // ARCHIVE_ALL_CHANNELS=false to restrict indexing to the storage channel.
    bot.on('channel_post', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      if (!env.ARCHIVE_ALL_CHANNELS && chatId !== env.MUSIC_STORAGE_CHANNEL_ID) return;
      const post = ctx.channelPost as { audio?: TgAudio; document?: TgDocument } | undefined;
      const audio = post?.audio;
      const doc = post?.document;
      let res: { indexed: boolean } | null = null;
      if (audio?.file_id) {
        res = await indexAudio({
          fileId: audio.file_id,
          title: audio.title || audio.file_name || 'غير معروف',
          artist: audio.performer ?? null,
          duration: audio.duration ?? 0,
          source: 'channel',
          kind: 'audio',
        });
      } else if (isAudioDoc(doc)) {
        res = await indexAudio({
          fileId: doc.file_id,
          title: (doc.file_name || 'غير معروف').replace(AUDIO_EXT, ''),
          duration: 0,
          source: 'channel',
          kind: 'document',
        });
      }
      if (res?.indexed) log.info({ chatId }, 'archived channel audio');
    });

    bot.command('archivecount', requireRole('owner'), async (ctx) => {
      const n = await archiveCount();
      await ctx.reply(`🗂 الأرشيف الصوتي: ${n} أغنية.`);
    });

    // Bulk-import audio from a source channel via the assistant account. The
    // streamer does the slow, ban-safe copying into the storage channel; the
    // bot's channel_post handler above then indexes each copied track. Progress
    // is relayed back through POST /import/progress.
    bot.command('import', requireRole('owner'), async (ctx) => {
      if (!STREAMER_URL)
        return void ctx.reply('🎧 خدمة البث مش مفعّلة (STREAMER_URL). الاستيراد يحتاجها.');
      if (!env.MUSIC_STORAGE_CHANNEL_ID)
        return void ctx.reply('⚠️ ما في قناة أرشيف مضبوطة (MUSIC_STORAGE_CHANNEL_ID).');
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const source = parts[0];
      const limit = Math.max(1, Math.min(Number(parts[1]) || 50, 200));
      if (!source)
        return void ctx.reply(
          '📥 الاستخدام:\n/import <رابط أو @معرّف القناة> <العدد>\nمثال: /import @songs 100\n\nالاستيراد بطيء ومتحفّظ (الحظر أخطر من البطء).',
        );
      const r = await callStreamer('/import', { source, limit, notify_chat: ctx.chat.id });
      if (r?.ok) {
        await ctx.reply(`📥 بدأ الاستيراد من ${source} (حد ${r.limit ?? limit}). بوصلك تقدّم أول بأول.`);
      } else {
        const e = String(r?.error || 'unreachable');
        const msg =
          e === 'already_importing'
            ? '⏳ في استيراد شغّال حالياً. استنى يخلص أو /importstop.'
            : e === 'no_storage_channel'
              ? '⚠️ قناة الأرشيف مش مضبوطة عند خدمة البث.'
              : e === 'starting'
                ? '⏳ خدمة البث لسه عم تشتغل، جرّب بعد شوي.'
                : '⚠️ تعذّر بدء الاستيراد، تأكد من الرابط وخدمة البث.';
        await ctx.reply(msg);
      }
    });

    bot.command('importstop', requireRole('owner'), async (ctx) => {
      if (!STREAMER_URL) return void ctx.reply('🎧 خدمة البث مش مفعّلة.');
      const r = await callStreamer('/importstop', {});
      await ctx.reply(r?.ok ? '🛑 طلبت إيقاف الاستيراد.' : '⚠️ تعذّر إيقاف الاستيراد.');
    });
  },
};
