import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { photoToSticker, applyEffect, addText, type StickerEffect } from '../../services/sticker';
import { largestPhoto, wantsSticker } from './logic';
import { pendingText } from './state';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:sticker');
const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

// Edit prompt message → source photo fileId.
const editSources = new Map<string, string>();

const editKeyboard = () =>
  Markup.inlineKeyboard([[
    Markup.button.callback('⬜ حدود', 'stk:border'),
    Markup.button.callback('✂️ دائري', 'stk:circle'),
    Markup.button.callback('✍️ نص', 'stk:text'),
  ]]);

/** Convert photos to stickers, with border / circle / caption edits. */
export const stickerPlugin: Plugin = {
  name: 'sticker',
  description: 'Convert a photo into a sticker (with edits)',
  commands: [{ command: 'sticker', description: '🩷 حوّل صورة إلى ملصق (بالرد على صورة أو أرسلها)' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('sticker', async (ctx) => {
      const msg = ctx.message as { photo?: unknown; reply_to_message?: unknown };
      const src = largestPhoto(msg) ?? largestPhoto(msg.reply_to_message);
      if (!src) return void ctx.reply('🩷 أرسل صورة مع /ملصق، أو ردّ على صورة بكلمة «ملصق».');
      await makeSticker(ctx, src.fileId);
    });

    bot.on(message('photo'), async (ctx, next) => {
      const src = largestPhoto(ctx.message);
      if (!src) return next();
      const caption = (ctx.message as { caption?: string }).caption;
      const shouldConvert = ctx.chat?.type === 'private' || (isGroup(ctx) && wantsSticker(caption));
      if (!shouldConvert) return next();
      await makeSticker(ctx, src.fileId);
    });

    // Border / circle effects.
    bot.action(/^stk:(border|circle)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const fileId = editSources.get(key);
      if (!fileId) return void ctx.answerCbQuery('انتهت الصلاحية، أعد إرسال الصورة.').catch(() => undefined);
      await ctx.answerCbQuery('⏳ جاري التعديل...').catch(() => undefined);
      const buf = await fetchImage(ctx, fileId);
      if (!buf) return void ctx.reply('❌ تعذّر جلب الصورة.');
      const out = await applyEffect(buf, ctx.match[1] as StickerEffect);
      if (!out) return void ctx.reply('⚠️ تعذّر تطبيق التعديل.');
      try {
        await ctx.replyWithSticker(Input.fromLocalFile(out.filePath));
      } finally {
        await out.cleanup();
      }
    });

    // Caption: ask for text, then draw it.
    bot.action('stk:text', async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const fileId = editSources.get(key);
      if (!fileId) return void ctx.answerCbQuery('انتهت الصلاحية، أعد إرسال الصورة.').catch(() => undefined);
      pendingText.set(`${ctx.chat!.id}:${ctx.from.id}`, fileId);
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.reply('✍️ أرسل النص الذي تريده على الملصق:').catch(() => undefined);
    });

    bot.on(message('text'), async (ctx, next) => {
      const key = `${ctx.chat!.id}:${ctx.from.id}`;
      const fileId = pendingText.get(key);
      if (!fileId) return next();
      pendingText.delete(key);
      const text = ctx.message.text.trim();
      if (!text || text.startsWith('/')) return void ctx.reply('❌ أرسل نصاً عادياً.');
      const buf = await fetchImage(ctx, fileId);
      if (!buf) return void ctx.reply('❌ تعذّر جلب الصورة.');
      const out = await addText(buf, text.slice(0, 60));
      if (!out) return void ctx.reply('⚠️ تعذّر إضافة النص (قد لا يدعم الخادم الخطوط).');
      try {
        await ctx.replyWithSticker(Input.fromLocalFile(out.filePath));
      } finally {
        await out.cleanup();
      }
    });
  },
};

async function fetchImage(ctx: BotContext, fileId: string): Promise<Buffer | null> {
  const link = await ctx.telegram.getFileLink(fileId).catch(() => null);
  if (!link) return null;
  const res = await fetch(link.toString()).catch(() => null);
  if (!res?.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function makeSticker(ctx: BotContext, fileId: string): Promise<void> {
  const buf = await fetchImage(ctx, fileId);
  if (!buf) return void ctx.reply('❌ تعذّر تحميل الصورة.');
  const stk = await photoToSticker(buf);
  if (!stk) return void ctx.reply('⚠️ تعذّر تحويل الصورة إلى ملصق، حاول بصورة أخرى.');
  try {
    await ctx.replyWithSticker(Input.fromLocalFile(stk.filePath));
    const prompt = await ctx.reply('🎨 عدّل الملصق:', editKeyboard());
    if (ctx.chat) editSources.set(`${ctx.chat.id}:${prompt.message_id}`, fileId);
  } catch (err) {
    log.warn({ err }, 'send sticker failed');
    await ctx.reply('⚠️ تعذّر إرسال الملصق.');
  } finally {
    await stk.cleanup();
  }
}
