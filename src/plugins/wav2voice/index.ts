import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:wav2voice');

// Telegram bots can only download files up to ~20MB via getFile.
const MAX_BYTES = 20 * 1024 * 1024;

interface WavSource {
  fileId: string;
  name: string;
  size?: number;
}

/** A WAV audio/document inside a message, or null. */
function wavFromMessage(msg: unknown): WavSource | null {
  const m = msg as {
    audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  const isWav = (name?: string, mime?: string): boolean =>
    /\.wav$/i.test(name ?? '') || /\bwave?\b|x-wav/i.test(mime ?? '');
  const f = m?.audio ?? m?.document;
  if (f && isWav(f.file_name, f.mime_type)) {
    return { fileId: f.file_id, name: f.file_name ?? 'audio.wav', size: f.file_size };
  }
  return null;
}

/** Stream a URL to a local file. Returns false on failure. */
async function downloadTo(url: string, dest: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    if (!r.ok || !r.body) return false;
    await pipeline(
      Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest),
    );
    return true;
  } catch {
    return false;
  }
}

/** Convert any audio file to OGG/Opus (a Telegram voice note). False on failure. */
function toVoiceNote(input: string, output: string): Promise<boolean> {
  return new Promise((resolve) => {
    // -vn: drop any cover art. Opus@48k is what Telegram voice notes use;
    // channels are preserved so a stereo recording stays stereo.
    const p = spawn(
      'ffmpeg',
      ['-y', '-i', input, '-vn', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', output],
      { stdio: 'ignore' },
    );
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function handle(ctx: BotContext, src: WavSource): Promise<void> {
  if (!ctx.chat) return;
  if (src.size && src.size > MAX_BYTES) {
    await ctx
      .reply('⚠️ ملف الـWAV كبير جداً (الحد ~20MB للتنزيل عبر البوت). جرّب ملف أقصر.')
      .catch(() => undefined);
    return;
  }

  const status = await ctx.reply('🎧 جاري تحويل الملف لرسالة صوتية… ⏳').catch(() => undefined);
  const statusId = (status as { message_id?: number } | undefined)?.message_id;
  await ctx.sendChatAction('upload_voice').catch(() => undefined);

  const editOrReply = (text: string): Promise<unknown> =>
    statusId
      ? ctx.telegram.editMessageText(ctx.chat!.id, statusId, undefined, text).catch(() => undefined)
      : ctx.reply(text).catch(() => undefined);

  const dir = await mkdtemp(join(tmpdir(), 'wav2v-'));
  const cleanup = (): Promise<unknown> => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const inPath = join(dir, 'in.wav');
  const outPath = join(dir, 'voice.ogg');

  try {
    const link = await ctx.telegram.getFileLink(src.fileId).catch(() => null);
    if (!link) return void (await editOrReply('⚠️ تعذّر جلب الملف.'));
    if (!(await downloadTo(link.toString(), inPath)))
      return void (await editOrReply('⚠️ تعذّر تنزيل الملف.'));
    if (!(await toVoiceNote(inPath, outPath)))
      return void (await editOrReply('⚠️ تعذّر التحويل. تأكد إنه ملف صوت WAV سليم.'));
    if ((await stat(outPath)).size <= 0) return void (await editOrReply('⚠️ الناتج فارغ.'));

    await ctx.replyWithVoice(Input.fromLocalFile(outPath)).catch(() => undefined);
    if (statusId) await ctx.telegram.deleteMessage(ctx.chat.id, statusId).catch(() => undefined);
  } catch (err) {
    log.error({ err }, 'wav2voice failed');
    await editOrReply('⚠️ صار خطأ أثناء التحويل.');
  } finally {
    await cleanup();
  }
}

/**
 * 🎧 Send a WAV file (as a document or audio) and the bot replies with it as a
 * Telegram voice message (OGG/Opus). Auto-triggers on any incoming WAV; passes
 * every other file through untouched.
 */
export const wav2voicePlugin: Plugin = {
  name: 'wav2voice',
  description: 'Convert an incoming WAV file into a Telegram voice message',

  register(bot: Telegraf<BotContext>) {
    bot.on(message('document'), async (ctx, next) => {
      const src = wavFromMessage(ctx.message);
      if (!src) return next();
      await handle(ctx, src);
    });
    bot.on(message('audio'), async (ctx, next) => {
      const src = wavFromMessage(ctx.message);
      if (!src) return next();
      await handle(ctx, src);
    });
  },
};
