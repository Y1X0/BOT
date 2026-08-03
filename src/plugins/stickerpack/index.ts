import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { photoToSticker, photoToEmoji } from '../../services/sticker';
import { videoToSticker } from '../../services/videosticker';
import { getPack, savePack, type PackKind } from '../../services/stickerpack.service';
import { largestPhoto } from '../sticker/logic';
import { packState } from './state';
import { packName } from './logic';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:stickerpack');
const DEFAULT_EMOJI = '😀';
const ADD_RE = /أضف|اضف|addpack|للمجموع/i;
const EMOJI_ADD_RE = /رمز|ايموجي|إيموجي|emoji/i;

type MediaType = 'photo' | 'video';
interface KindCfg {
  label: string;
  addr: string;
  stickerType: 'regular' | 'custom_emoji';
  format: 'static' | 'video';
  media: MediaType;
  ext: string;
  convert: (b: Buffer) => Promise<Buffer | null>;
}
const KINDS: Record<PackKind, KindCfg> = {
  regular: { label: 'ملصقات', addr: 'addstickers', stickerType: 'regular', format: 'static', media: 'photo', ext: 'webp', convert: photoToSticker },
  emoji: { label: 'رموز مميزة', addr: 'addemoji', stickerType: 'custom_emoji', format: 'static', media: 'photo', ext: 'webp', convert: photoToEmoji },
  video: { label: 'ملصقات فيديو', addr: 'addstickers', stickerType: 'regular', format: 'video', media: 'video', ext: 'webm', convert: videoToSticker },
};
const link = (kind: PackKind, name: string) => `https://t.me/${KINDS[kind].addr}/${name}`;

/** Create/manage personal sticker sets and custom-emoji sets via the bot. */
export const stickerPackPlugin: Plugin = {
  name: 'stickerpack',
  description: 'Create sticker sets and custom-emoji (premium) sets',
  commands: [
    { command: 'newpack', description: '📦 أنشئ مجموعة ملصقات: /newpack الاسم' },
    { command: 'newemoji', description: '✨ أنشئ مجموعة رموز مميزة: /newemoji الاسم' },
    { command: 'addsticker', description: '➕ أضف ملصق (بالرد على صورة)' },
    { command: 'addemoji', description: '➕ أضف رمز مميز (بالرد على صورة)' },
    { command: 'mypack', description: '🧷 رابط مجموعة الملصقات' },
    { command: 'myemoji', description: '🧷 رابط مجموعة الرموز المميزة' },
  ],

  register(bot: Telegraf<BotContext>) {
    const startNew = (kind: PackKind) => async (ctx: BotContext & { message: { text: string } }) => {
      if (!ctx.from) return;
      const title = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (title) {
        packState.set(ctx.from.id, { step: 'image', title: title.slice(0, 64), kind });
        return void ctx.reply(`${kind === 'emoji' ? '✨' : '📦'} «${title}» — أرسل أول صورة 🖼️`);
      }
      packState.set(ctx.from.id, { step: 'title', kind });
      await ctx.reply(`${kind === 'emoji' ? '✨' : '📦'} أرسل اسم المجموعة (العنوان):`);
    };
    bot.command('newpack', startNew('regular'));
    bot.command('newemoji', startNew('emoji'));
    bot.command('newvideo', startNew('video'));

    const showPack = (kind: PackKind) => async (ctx: BotContext) => {
      if (!ctx.from) return;
      const p = await getPack(ctx.from.id, kind);
      if (!p) return void ctx.reply(`لا توجد لديك ${KINDS[kind].label}. أنشئ بـ ${kind === 'emoji' ? '/newemoji' : '/newpack'}`);
      await ctx.reply(`🧷 «${p.title}»:\n${link(kind, p.name)}`);
    };
    bot.command('mypack', showPack('regular'));
    bot.command('myemoji', showPack('emoji'));
    bot.command('myvideo', showPack('video'));

    const addCmd = (kind: PackKind) => async (ctx: BotContext) => {
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      const src = mediaOf(ctx.message) ?? mediaOf(replied);
      if (!src) return void ctx.reply('➕ ردّ على الوسيط بهذا الأمر لإضافته.');
      if (src.type !== KINDS[kind].media) return void ctx.reply(KINDS[kind].media === 'video' ? '❌ ردّ على فيديو/GIF.' : '❌ ردّ على صورة.');
      await addToPack(ctx, src.fileId, kind);
    };
    bot.command('addsticker', addCmd('regular'));
    bot.command('addemoji', addCmd('emoji'));
    bot.command('addvideo', addCmd('video'));

    // Pack-creation title step.
    bot.on(message('text'), async (ctx, next) => {
      if (!ctx.from) return next();
      const st = packState.get(ctx.from.id);
      if (st?.step !== 'title') return next();
      const title = ctx.message.text.trim();
      if (!title || title.startsWith('/')) return void ctx.reply('❌ أرسل اسماً نصياً للمجموعة.');
      packState.set(ctx.from.id, { step: 'image', title: title.slice(0, 64), kind: st.kind });
      await ctx.reply(`«${title}» — أرسل أول صورة 🖼️`);
    });

    // Media (photo/video/GIF): first item of a new set, or "add" to an existing.
    const onMedia = async (ctx: BotContext, next: () => Promise<void>) => {
      if (!ctx.from) return next();
      const src = mediaOf(ctx.message);
      if (!src) return next();
      const st = packState.get(ctx.from.id);
      if (st?.step === 'image') {
        if (src.type !== KINDS[st.kind].media) {
          return void ctx.reply(KINDS[st.kind].media === 'video' ? '❌ أرسل فيديو/GIF.' : '❌ أرسل صورة.');
        }
        packState.delete(ctx.from.id);
        await createPack(ctx, src.fileId, st.title ?? 'مجموعتي', st.kind);
        return;
      }
      const caption = (ctx.message as { caption?: string }).caption;
      if (caption && ADD_RE.test(caption)) {
        const kind: PackKind = src.type === 'video' ? 'video' : EMOJI_ADD_RE.test(caption) ? 'emoji' : 'regular';
        await addToPack(ctx, src.fileId, kind);
        return;
      }
      return next();
    };
    bot.on(message('photo'), onMedia);
    bot.on(message('video'), onMedia);
    bot.on(message('animation'), onMedia);
  },
};

function mediaOf(msg: unknown): { fileId: string; type: MediaType } | null {
  const p = largestPhoto(msg);
  if (p) return { fileId: p.fileId, type: 'photo' };
  const m = msg as { video?: { file_id: string }; animation?: { file_id: string } };
  if (m?.video) return { fileId: m.video.file_id, type: 'video' };
  if (m?.animation) return { fileId: m.animation.file_id, type: 'video' };
  return null;
}

async function toFileId(ctx: BotContext, fileId: string, kind: PackKind): Promise<string | null> {
  const dlLink = await ctx.telegram.getFileLink(fileId).catch(() => null);
  if (!dlLink) return null;
  const res = await fetch(dlLink.toString()).catch(() => null);
  if (!res?.ok) return null;
  const cfg = KINDS[kind];
  const media = await cfg.convert(Buffer.from(await res.arrayBuffer()));
  if (!media) return null;
  const uploaded = await ctx.telegram
    .uploadStickerFile(ctx.from!.id, Input.fromBuffer(media, `sticker.${cfg.ext}`), cfg.format)
    .catch((err) => {
      log.warn({ err }, 'uploadStickerFile failed');
      return null;
    });
  return uploaded?.file_id ?? null;
}

async function createPack(ctx: BotContext, fileId: string, title: string, kind: PackKind): Promise<void> {
  const username = ctx.botInfo?.username;
  if (!username || !ctx.from) return void ctx.reply('⚠️ تعذّر التجهيز الآن، حاول لاحقاً.');
  await ctx.reply('⏳ جاري الإنشاء...').catch(() => undefined);
  const stickerId = await toFileId(ctx, fileId, kind);
  if (!stickerId) return void ctx.reply('❌ تعذّر تجهيز الملصق من الصورة.');

  const name = packName(ctx.from.id, username, 10000 + Math.floor(Math.random() * 89999));
  try {
    await ctx.telegram.createNewStickerSet(ctx.from.id, name, title, {
      stickers: [{ sticker: stickerId, emoji_list: [DEFAULT_EMOJI] }],
      sticker_format: KINDS[kind].format,
      sticker_type: KINDS[kind].stickerType,
    });
  } catch (err) {
    log.warn({ err }, 'createNewStickerSet failed');
    return void ctx.reply('⚠️ تعذّر إنشاء المجموعة. تأكد أنك بدأت محادثة البوت وحاول مجدداً.');
  }
  await savePack(ctx.from.id, kind, name, title);
  await ctx.reply(`✅ تم إنشاء «${title}»!\n🧷 ${link(kind, name)}\n\n➕ للإضافة: أرسل صورة مع كلمة «${kind === 'emoji' ? 'أضف رمز' : 'أضف'}»، أو ردّ على صورة بـ ${kind === 'emoji' ? '/addemoji' : '/addsticker'}.`);
}

async function addToPack(ctx: BotContext, fileId: string, kind: PackKind): Promise<void> {
  if (!ctx.from) return;
  const pack = await getPack(ctx.from.id, kind);
  if (!pack) return void ctx.reply(`لا توجد لديك ${KINDS[kind].label}. أنشئ بـ ${kind === 'emoji' ? '/newemoji' : '/newpack'}`);
  await ctx.reply('⏳ جاري الإضافة...').catch(() => undefined);
  const stickerId = await toFileId(ctx, fileId, kind);
  if (!stickerId) return void ctx.reply('❌ تعذّر تجهيز الملصق من الصورة.');
  try {
    await ctx.telegram.addStickerToSet(ctx.from.id, pack.name, {
      sticker: { sticker: stickerId, emoji_list: [DEFAULT_EMOJI] },
    });
  } catch (err) {
    log.warn({ err }, 'addStickerToSet failed');
    return void ctx.reply('⚠️ تعذّر الإضافة (قد تكون المجموعة ممتلئة أو محذوفة).');
  }
  await ctx.reply(`✅ تمت الإضافة إلى «${pack.title}»!\n🧷 ${link(kind, pack.name)}`);
}
