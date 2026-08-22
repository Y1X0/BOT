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
    // Any audio landing in the configured storage channel gets indexed.
    bot.on('channel_post', async (ctx) => {
      const storageId = env.MUSIC_STORAGE_CHANNEL_ID;
      if (!storageId || ctx.chat?.id !== storageId) return;
      const audio = (ctx.channelPost as { audio?: TgAudio } | undefined)?.audio;
      if (!audio?.file_id) return;
      const res = await indexAudio({
        fileId: audio.file_id,
        title: audio.title || audio.file_name || 'غير معروف',
        artist: audio.performer ?? null,
        duration: audio.duration ?? 0,
        source: 'channel',
      });
      if (res.indexed) log.info({ title: audio.title }, 'archived channel audio');
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
