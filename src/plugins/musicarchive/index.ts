import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { requireRole } from '../../utils/permissions';
import { indexAudio, archiveCount } from '../../services/archive';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:musicarchive');

type TgAudio = { file_id: string; title?: string; performer?: string; file_name?: string; duration?: number };

/** Auto-index audio posted to the storage channel, and expose the archive size. */
export const musicArchivePlugin: Plugin = {
  name: 'musicarchive',
  description: 'Index audio from the storage channel into the archive',
  commands: [{ command: 'archivecount', description: '🗂 عدد الأغاني بالأرشيف (مالك)', staffOnly: true }],

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
  },
};
