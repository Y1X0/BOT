import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { photoToSticker } from '../../services/sticker';
import { largestPhoto, wantsSticker } from './logic';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:sticker');
const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Turn any photo the bot receives into a Telegram sticker. */
export const stickerPlugin: Plugin = {
  name: 'sticker',
  description: 'Convert a photo into a sticker',
  commands: [{ command: 'sticker', description: '🩷 حوّل صورة إلى ملصق (بالرد على صورة أو أرسلها)' }],

  register(bot: Telegraf<BotContext>) {
    // /sticker or "ملصق" — from a replied photo or a photo sent with the command.
    bot.command('sticker', async (ctx) => {
      const msg = ctx.message as { photo?: unknown; reply_to_message?: unknown };
      const src = largestPhoto(msg) ?? largestPhoto(msg.reply_to_message);
      if (!src) return void ctx.reply('🩷 أرسل صورة مع /ملصق، أو ردّ على صورة بكلمة «ملصق».');
      await makeSticker(ctx, src.fileId);
    });

    // Any photo: auto-convert in the bot's DM; in groups only when the caption
    // asks for it (so it doesn't fire on every posted photo).
    bot.on(message('photo'), async (ctx, next) => {
      const src = largestPhoto(ctx.message);
      if (!src) return next();
      const caption = (ctx.message as { caption?: string }).caption;
      const shouldConvert = ctx.chat?.type === 'private' || (isGroup(ctx) && wantsSticker(caption));
      if (!shouldConvert) return next();
      await makeSticker(ctx, src.fileId);
    });
  },
};

async function makeSticker(ctx: BotContext, fileId: string): Promise<void> {
  const link = await ctx.telegram.getFileLink(fileId).catch(() => null);
  if (!link) return void ctx.reply('❌ تعذّر جلب الصورة.');
  const res = await fetch(link.toString()).catch(() => null);
  if (!res?.ok) return void ctx.reply('❌ تعذّر تحميل الصورة.');
  const buf = Buffer.from(await res.arrayBuffer());

  const stk = await photoToSticker(buf);
  if (!stk) return void ctx.reply('⚠️ تعذّر تحويل الصورة إلى ملصق، حاول بصورة أخرى.');
  try {
    await ctx.replyWithSticker(Input.fromLocalFile(stk.filePath));
  } catch (err) {
    log.warn({ err }, 'send sticker failed');
    await ctx.reply('⚠️ تعذّر إرسال الملصق.');
  } finally {
    await stk.cleanup();
  }
}
