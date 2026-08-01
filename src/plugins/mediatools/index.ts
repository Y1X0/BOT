import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { downloadTo, ffmpegToMp3 } from '../../services/youtube/media';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:mediatools');

/** Extract a downloadable file_id + title from a replied media message. */
function extractMedia(msg: unknown): { fileId: string; title: string } | null {
  const m = msg as {
    video?: { file_id: string; file_name?: string };
    audio?: { file_id: string; title?: string; file_name?: string };
    voice?: { file_id: string };
    video_note?: { file_id: string };
    document?: { file_id: string; mime_type?: string; file_name?: string };
  };
  if (m.video) return { fileId: m.video.file_id, title: m.video.file_name ?? 'video' };
  if (m.audio) return { fileId: m.audio.file_id, title: m.audio.title ?? m.audio.file_name ?? 'audio' };
  if (m.voice) return { fileId: m.voice.file_id, title: 'voice' };
  if (m.video_note) return { fileId: m.video_note.file_id, title: 'video_note' };
  if (m.document && /video|audio/.test(m.document.mime_type ?? '')) {
    return { fileId: m.document.file_id, title: m.document.file_name ?? 'media' };
  }
  return null;
}

export const mediaToolsPlugin: Plugin = {
  name: 'mediatools',
  description: 'Convert a replied video/voice to MP3',
  commands: [{ command: 'mp3', description: '🎵 حوّل فيديو/صوت إلى MP3 (بالرد)' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('mp3', async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      const media = replied ? extractMedia(replied) : null;
      if (!media) {
        await ctx.reply('🎵 ردّ على فيديو أو مقطع صوتي واكتب /mp3');
        return;
      }

      const status = await ctx.reply('⬇️ جاري التحويل...').catch(() => undefined);
      const dir = await mkdtemp(join(tmpdir(), 'm2-'));
      const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
      try {
        // Bot API can only download files up to ~20MB.
        const link = await ctx.telegram.getFileLink(media.fileId).catch(() => null);
        if (!link) {
          await editOrReply(ctx, status, '❌ تعذّر جلب الملف (قد يكون أكبر من 20 ميجا).');
          return;
        }
        const src = join(dir, 'src');
        const out = join(dir, 'out.mp3');
        if (!(await downloadTo(link.toString(), src)) || !(await ffmpegToMp3(src, out))) {
          await editOrReply(ctx, status, '❌ فشل التحويل.');
          return;
        }
        if ((await stat(out)).size === 0) {
          await editOrReply(ctx, status, '❌ الملف الناتج فارغ.');
          return;
        }
        await ctx.replyWithAudio(Input.fromLocalFile(out), { title: media.title, performer: 'Converted' });
        if (status) await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => undefined);
      } catch (err) {
        log.error({ err }, 'mp3 convert failed');
        await editOrReply(ctx, status, '❌ حدث خطأ أثناء التحويل.');
      } finally {
        await cleanup();
      }
    });
  },
};

async function editOrReply(
  ctx: BotContext,
  status: { message_id: number } | undefined,
  text: string,
): Promise<void> {
  if (status) await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, text).catch(() => undefined);
  else await ctx.reply(text).catch(() => undefined);
}
