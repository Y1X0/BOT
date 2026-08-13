import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { photoToSticker, photoToEmoji } from '../../services/sticker';
import { videoToSticker, videoToEmoji } from '../../services/videosticker';
import { getPack, savePack, type PackKind } from '../../services/stickerpack.service';
import { getSavedEmoji, addSavedEmoji, clearSavedEmoji, extractCustomEmoji } from '../../services/savedemoji.service';
import { largestPhoto } from '../sticker/logic';
import { packState } from './state';
import { packName } from './logic';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:stickerpack');
const DEFAULT_EMOJI = '😀';
const ADD_RE = /أضف|اضف|addpack|للمجموع/i;
const EMOJI_ADD_RE = /رمز|ايموجي|إيموجي|emoji/i;

type MediaType = 'photo' | 'video';

// Two set kinds; each accepts BOTH photos and videos (mixed-format sets).
const KINDS: Record<PackKind, { label: string; addr: string; stickerType: 'regular' | 'custom_emoji' }> = {
  regular: { label: 'ملصقات', addr: 'addstickers', stickerType: 'regular' },
  emoji: { label: 'رموز مميزة', addr: 'addemoji', stickerType: 'custom_emoji' },
};
const link = (kind: PackKind, name: string) => `https://t.me/${KINDS[kind].addr}/${name}`;

/** Choose the right converter for a kind + incoming media type. */
function convert(kind: PackKind, media: MediaType, buf: Buffer): Promise<Buffer | null> {
  if (kind === 'emoji') return media === 'video' ? videoToEmoji(buf) : photoToEmoji(buf);
  return media === 'video' ? videoToSticker(buf) : photoToSticker(buf);
}

/** Create/manage personal sticker & custom-emoji sets (photos + videos mixed). */
export const stickerPackPlugin: Plugin = {
  name: 'stickerpack',
  description: 'Create sticker/custom-emoji sets that accept photos and videos',
  commands: [
    { command: 'newpack', description: '📦 أنشئ مجموعة ملصقات (صور + فيديو): /newpack الاسم' },
    { command: 'newemoji', description: '✨ أنشئ مجموعة رموز مميزة (صور + فيديو): /newemoji الاسم' },
    { command: 'addsticker', description: '➕ أضف للمجموعة (بالرد على صورة/فيديو)' },
    { command: 'addemoji', description: '➕ أضف رمزاً مميزاً (بالرد على صورة/فيديو)' },
    { command: 'mypack', description: '🧷 رابط مجموعة الملصقات' },
    { command: 'myemoji', description: '🧷 رابط مجموعة الرموز المميزة' },
    { command: 'saveemoji', description: '✨ احفظ رموزاً مميزة (بالرد على رسالة فيها رموز)' },
    { command: 'pemoji', description: '✨ يبعت رموزك المميزة المحفوظة: /pemoji [نص]' },
    { command: 'clearemoji', description: '🗑 امسح الرموز المميزة المحفوظة' },
  ],

  register(bot: Telegraf<BotContext>) {
    const startNew = (kind: PackKind) => async (ctx: BotContext & { message: { text: string } }) => {
      if (!ctx.from) return;
      const title = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const icon = kind === 'emoji' ? '✨' : '📦';
      if (title) {
        packState.set(ctx.from.id, { step: 'image', title: title.slice(0, 64), kind });
        return void ctx.reply(`${icon} «${title}» — أرسل أول صورة أو فيديو 🖼️🎬`);
      }
      packState.set(ctx.from.id, { step: 'title', kind });
      await ctx.reply(`${icon} أرسل اسم المجموعة (العنوان):`);
    };
    bot.command('newpack', startNew('regular'));
    bot.command('newemoji', startNew('emoji'));

    const showPack = (kind: PackKind) => async (ctx: BotContext) => {
      if (!ctx.from) return;
      const p = await getPack(ctx.from.id, kind);
      if (!p) return void ctx.reply(`لا توجد لديك ${KINDS[kind].label}. أنشئ بـ ${kind === 'emoji' ? '/newemoji' : '/newpack'}`);
      await ctx.reply(`🧷 «${p.title}»:\n${link(kind, p.name)}`);
    };
    bot.command('mypack', showPack('regular'));
    bot.command('myemoji', showPack('emoji'));

    // Grab premium (custom) emoji from any message and save them.
    bot.command('saveemoji', async (ctx) => {
      if (!ctx.from) return;
      const msg = ctx.message as {
        text?: string;
        entities?: never[];
        reply_to_message?: { text?: string; caption?: string; entities?: never[]; caption_entities?: never[] };
      };
      const r = msg.reply_to_message;
      const items = [
        ...(r ? extractCustomEmoji(r.text ?? r.caption ?? '', r.entities ?? r.caption_entities ?? []) : []),
        ...extractCustomEmoji(msg.text ?? '', msg.entities ?? []),
      ];
      if (!items.length) {
        return void ctx.reply('✨ ردّ على رسالة فيها رموز مميزة (أو أرسلها بعد الأمر) لأحفظها.\nملاحظة: تحتاج Telegram Premium حتى ترسل رموز مميزة.');
      }
      const total = await addSavedEmoji(ctx.from.id, items);
      await ctx.reply(`✅ حفظت ${items.length} رمزاً. المجموع المحفوظ: ${total}.\nأرسلها بـ /pemoji`);
    });

    bot.command('clearemoji', async (ctx) => {
      if (!ctx.from) return;
      await clearSavedEmoji(ctx.from.id);
      await ctx.reply('🗑 تم مسح الرموز المميزة المحفوظة.');
    });

    // Send the user's saved custom emoji inline (falls back to their /newemoji
    // pack). Requires the bot owner to have Telegram Premium to actually render.
    bot.command('pemoji', async (ctx) => {
      if (!ctx.from || !ctx.chat) return;
      let items = await getSavedEmoji(ctx.from.id);
      if (!items.length) {
        const pack = await getPack(ctx.from.id, 'emoji');
        const set = pack ? await ctx.telegram.getStickerSet(pack.name).catch(() => null) : null;
        items = (set?.stickers ?? [])
          .filter((s) => s.custom_emoji_id)
          .map((s) => ({ e: s.emoji || '⭐', id: s.custom_emoji_id! }));
      }
      items = items.slice(0, 12);
      if (!items.length) {
        return void ctx.reply('✨ لا رموز محفوظة. ردّ على رسالة فيها رموز مميزة واكتب /saveemoji، أو أنشئ حزمة بـ /newemoji.');
      }
      const extra = ctx.message.text.split(' ').slice(1).join(' ').trim();
      let text = '';
      const entities: { type: 'custom_emoji'; offset: number; length: number; custom_emoji_id: string }[] = [];
      for (const it of items) {
        const emo = it.e || '⭐';
        entities.push({ type: 'custom_emoji', offset: text.length, length: emo.length, custom_emoji_id: it.id });
        text += emo;
      }
      if (extra) text += ' ' + extra;
      await ctx.telegram
        .sendMessage(ctx.chat.id, text, { entities })
        .catch(() => ctx.reply('⚠️ تعذّر إرسال الرموز المميزة.\nتأكد أن مالك البوت عنده اشتراك Telegram Premium.').catch(() => undefined));
    });

    const addCmd = (kind: PackKind) => async (ctx: BotContext) => {
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      const src = mediaOf(ctx.message) ?? mediaOf(replied);
      if (!src) return void ctx.reply('➕ ردّ على صورة أو فيديو بهذا الأمر لإضافته.');
      await addToPack(ctx, src.fileId, kind, src.type);
    };
    bot.command('addsticker', addCmd('regular'));
    bot.command('addemoji', addCmd('emoji'));

    // Pack-creation title step.
    bot.on(message('text'), async (ctx, next) => {
      if (!ctx.from) return next();
      const st = packState.get(ctx.from.id);
      if (st?.step !== 'title') return next();
      const title = ctx.message.text.trim();
      if (!title || title.startsWith('/')) return void ctx.reply('❌ أرسل اسماً نصياً للمجموعة.');
      packState.set(ctx.from.id, { step: 'image', title: title.slice(0, 64), kind: st.kind });
      await ctx.reply(`«${title}» — أرسل أول صورة أو فيديو 🖼️🎬`);
    });

    // Media (photo/video/GIF): first item of a new set, or "add" to an existing.
    const onMedia = async (ctx: BotContext, next: () => Promise<void>) => {
      if (!ctx.from) return next();
      const src = mediaOf(ctx.message);
      if (!src) return next();
      const st = packState.get(ctx.from.id);
      if (st?.step === 'image') {
        packState.delete(ctx.from.id);
        await createPack(ctx, src.fileId, st.title ?? 'مجموعتي', st.kind, src.type);
        return;
      }
      const caption = (ctx.message as { caption?: string }).caption;
      if (caption && ADD_RE.test(caption)) {
        await addToPack(ctx, src.fileId, EMOJI_ADD_RE.test(caption) ? 'emoji' : 'regular', src.type);
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

/** Convert + upload; returns a sticker file_id and its format. */
async function prepare(
  ctx: BotContext,
  fileId: string,
  kind: PackKind,
  media: MediaType,
): Promise<{ id: string; format: 'static' | 'video' } | null> {
  const dlLink = await ctx.telegram.getFileLink(fileId).catch(() => null);
  if (!dlLink) return null;
  const res = await fetch(dlLink.toString()).catch(() => null);
  if (!res?.ok) return null;
  const out = await convert(kind, media, Buffer.from(await res.arrayBuffer()));
  if (!out) return null;
  const format = media === 'video' ? 'video' : 'static';
  const ext = media === 'video' ? 'webm' : 'webp';
  const uploaded = await ctx.telegram
    .uploadStickerFile(ctx.from!.id, Input.fromBuffer(out, `sticker.${ext}`), format)
    .catch((err) => {
      log.warn({ err }, 'uploadStickerFile failed');
      return null;
    });
  return uploaded ? { id: uploaded.file_id, format } : null;
}

// The installed @telegraf/types (7.1) lacks per-sticker `format`; the live API
// (7.2+) needs it for mixed-format sets, so we pass it through untyped.
function inputSticker(id: string, format: 'static' | 'video') {
  return { sticker: id, emoji_list: [DEFAULT_EMOJI], format };
}

async function createPack(ctx: BotContext, fileId: string, title: string, kind: PackKind, media: MediaType): Promise<void> {
  const username = ctx.botInfo?.username;
  if (!username || !ctx.from) return void ctx.reply('⚠️ تعذّر التجهيز الآن، حاول لاحقاً.');
  await ctx.reply('⏳ جاري الإنشاء...').catch(() => undefined);
  const prepared = await prepare(ctx, fileId, kind, media);
  if (!prepared) return void ctx.reply('❌ تعذّر تجهيز الملصق.');

  const name = packName(ctx.from.id, username, 10000 + Math.floor(Math.random() * 89999));
  try {
    await ctx.telegram.createNewStickerSet(ctx.from.id, name, title, {
      stickers: [inputSticker(prepared.id, prepared.format)],
      sticker_format: prepared.format,
      sticker_type: KINDS[kind].stickerType,
    } as never);
  } catch (err) {
    log.warn({ err }, 'createNewStickerSet failed');
    return void ctx.reply('⚠️ تعذّر إنشاء المجموعة. تأكد أنك بدأت محادثة البوت وحاول مجدداً.');
  }
  await savePack(ctx.from.id, kind, name, title);
  await ctx.reply(`✅ تم إنشاء «${title}»!\n🧷 ${link(kind, name)}\n\n➕ للإضافة: أرسل صورة أو فيديو مع كلمة «${kind === 'emoji' ? 'أضف رمز' : 'أضف'}»، أو ردّ عليه بـ ${kind === 'emoji' ? '/addemoji' : '/addsticker'}.`);
}

async function addToPack(ctx: BotContext, fileId: string, kind: PackKind, media: MediaType): Promise<void> {
  if (!ctx.from) return;
  const pack = await getPack(ctx.from.id, kind);
  if (!pack) return void ctx.reply(`لا توجد لديك ${KINDS[kind].label}. أنشئ بـ ${kind === 'emoji' ? '/newemoji' : '/newpack'}`);
  await ctx.reply('⏳ جاري الإضافة...').catch(() => undefined);
  const prepared = await prepare(ctx, fileId, kind, media);
  if (!prepared) return void ctx.reply('❌ تعذّر تجهيز الملصق.');
  try {
    await ctx.telegram.addStickerToSet(ctx.from.id, pack.name, {
      sticker: inputSticker(prepared.id, prepared.format),
    } as never);
  } catch (err) {
    log.warn({ err }, 'addStickerToSet failed');
    return void ctx.reply('⚠️ تعذّر الإضافة (قد تكون المجموعة ممتلئة أو محذوفة).');
  }
  await ctx.reply(`✅ تمت الإضافة إلى «${pack.title}»!\n🧷 ${link(kind, pack.name)}`);
}
