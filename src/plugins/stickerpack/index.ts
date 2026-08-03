import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { photoToSticker } from '../../services/sticker';
import { getPack, savePack } from '../../services/stickerpack.service';
import { largestPhoto } from '../sticker/logic';
import { packState } from './state';
import { packName } from './logic';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:stickerpack');
const DEFAULT_EMOJI = '😀';
const ADD_RE = /أضف|اضف|addpack|للمجموع/i;

/** Create and manage a personal sticker set via the bot. */
export const stickerPackPlugin: Plugin = {
  name: 'stickerpack',
  description: 'Create a sticker set and add stickers to it',
  commands: [
    { command: 'newpack', description: '📦 أنشئ مجموعة ملصقات: /newpack الاسم' },
    { command: 'addsticker', description: '➕ أضف ملصق لمجموعتك (بالرد على صورة)' },
    { command: 'mypack', description: '🧷 رابط مجموعتك' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('newpack', async (ctx) => {
      if (!ctx.from) return;
      const title = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (title) {
        packState.set(ctx.from.id, { step: 'image', title: title.slice(0, 64) });
        return void ctx.reply(`📦 «${title}» — أرسل أول صورة للمجموعة 🖼️`);
      }
      packState.set(ctx.from.id, { step: 'title' });
      await ctx.reply('📦 أرسل اسم المجموعة (العنوان):');
    });

    bot.command('mypack', async (ctx) => {
      if (!ctx.from) return;
      const p = await getPack(ctx.from.id);
      if (!p) return void ctx.reply('📦 لا توجد لديك مجموعة. أنشئ واحدة بـ /newpack');
      await ctx.reply(`🧷 مجموعتك «${p.title}»:\nhttps://t.me/addstickers/${p.name}`);
    });

    bot.command('addsticker', async (ctx) => {
      if (!ctx.from) return;
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      const src = largestPhoto(ctx.message) ?? largestPhoto(replied);
      if (!src) return void ctx.reply('➕ ردّ على صورة بـ /addsticker، أو أرسل صورة مع كلمة «أضف».');
      await addToPack(ctx, src.fileId);
    });

    // Pack-creation title step.
    bot.on(message('text'), async (ctx, next) => {
      if (!ctx.from) return next();
      const st = packState.get(ctx.from.id);
      if (st?.step !== 'title') return next();
      const title = ctx.message.text.trim();
      if (!title || title.startsWith('/')) return void ctx.reply('❌ أرسل اسماً نصياً للمجموعة.');
      packState.set(ctx.from.id, { step: 'image', title: title.slice(0, 64) });
      await ctx.reply(`📦 «${title}» — أرسل أول صورة للمجموعة 🖼️`);
    });

    // Photos: first image of a new pack, or "add" to an existing pack.
    bot.on(message('photo'), async (ctx, next) => {
      if (!ctx.from) return next();
      const st = packState.get(ctx.from.id);
      const src = largestPhoto(ctx.message);
      if (st?.step === 'image' && src) {
        packState.delete(ctx.from.id);
        await createPack(ctx, src.fileId, st.title ?? 'ملصقاتي');
        return; // consumed
      }
      const caption = (ctx.message as { caption?: string }).caption;
      if (src && caption && ADD_RE.test(caption)) {
        await addToPack(ctx, src.fileId);
        return; // consumed
      }
      return next();
    });
  },
};

async function toStickerFileId(ctx: BotContext, fileId: string): Promise<string | null> {
  const link = await ctx.telegram.getFileLink(fileId).catch(() => null);
  if (!link) return null;
  const res = await fetch(link.toString()).catch(() => null);
  if (!res?.ok) return null;
  const webp = await photoToSticker(Buffer.from(await res.arrayBuffer()));
  if (!webp) return null;
  const uploaded = await ctx.telegram
    .uploadStickerFile(ctx.from!.id, Input.fromBuffer(webp, 'sticker.webp'), 'static')
    .catch((err) => {
      log.warn({ err }, 'uploadStickerFile failed');
      return null;
    });
  return uploaded?.file_id ?? null;
}

async function createPack(ctx: BotContext, fileId: string, title: string): Promise<void> {
  const username = ctx.botInfo?.username;
  if (!username || !ctx.from) return void ctx.reply('⚠️ تعذّر التجهيز الآن، حاول لاحقاً.');
  await ctx.reply('⏳ جاري إنشاء المجموعة...').catch(() => undefined);
  const stickerId = await toStickerFileId(ctx, fileId);
  if (!stickerId) return void ctx.reply('❌ تعذّر تجهيز الملصق من الصورة.');

  const name = packName(ctx.from.id, username, 10000 + Math.floor(Math.random() * 89999));
  try {
    await ctx.telegram.createNewStickerSet(ctx.from.id, name, title, {
      stickers: [{ sticker: stickerId, emoji_list: [DEFAULT_EMOJI] }],
      sticker_format: 'static',
    });
  } catch (err) {
    log.warn({ err }, 'createNewStickerSet failed');
    return void ctx.reply('⚠️ تعذّر إنشاء المجموعة. تأكد أنك بدأت محادثة البوت، وحاول باسم آخر.');
  }
  await savePack(ctx.from.id, name, title);
  await ctx.reply(`✅ تم إنشاء مجموعة «${title}»!\n🧷 https://t.me/addstickers/${name}\n\n➕ لإضافة ملصقات: أرسل صورة مع كلمة «أضف»، أو ردّ على صورة بـ /addsticker.`);
}

async function addToPack(ctx: BotContext, fileId: string): Promise<void> {
  if (!ctx.from) return;
  const pack = await getPack(ctx.from.id);
  if (!pack) return void ctx.reply('📦 لا توجد لديك مجموعة بعد. أنشئ واحدة بـ /newpack');
  await ctx.reply('⏳ جاري الإضافة...').catch(() => undefined);
  const stickerId = await toStickerFileId(ctx, fileId);
  if (!stickerId) return void ctx.reply('❌ تعذّر تجهيز الملصق من الصورة.');
  try {
    await ctx.telegram.addStickerToSet(ctx.from.id, pack.name, {
      sticker: { sticker: stickerId, emoji_list: [DEFAULT_EMOJI] },
    });
  } catch (err) {
    log.warn({ err }, 'addStickerToSet failed');
    return void ctx.reply('⚠️ تعذّر إضافة الملصق (قد تكون المجموعة ممتلئة أو محذوفة).');
  }
  await ctx.reply(`✅ تمت إضافة الملصق لمجموعة «${pack.title}»!\n🧷 https://t.me/addstickers/${pack.name}`);
}
