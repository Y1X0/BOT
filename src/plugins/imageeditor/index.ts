import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { getImageProvider } from '../../services/image/provider';
import { EFFECTS, EFFECT_GROUPS, findEffect } from '../../services/image/effects';
import { QueueManager } from '../../services/youtube/queue';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:imageeditor');

interface Pending {
  fileId: string;
  fileUniqueId: string;
  requesterId: number;
  fromReply: boolean;
}
const pending = new Map<string, Pending>(); // `${chatId}:${menuMsgId}`
const resultCache = new Map<string, string>(); // `${fileUniqueId}:${effectId}` → telegram file_id
const imageQueue = new QueueManager();

// Per-chat daily usage.
const usage = new Map<string, { day: string; n: number }>();
const today = () => new Date().toISOString().slice(0, 10);
function canUse(chatId: number): boolean {
  const u = usage.get(String(chatId));
  return !u || u.day !== today() || u.n < env.IMAGE_DAILY_LIMIT;
}
function bump(chatId: number): void {
  const key = String(chatId);
  const u = usage.get(key);
  if (!u || u.day !== today()) usage.set(key, { day: today(), n: 1 });
  else u.n++;
}

function photoOf(msg: unknown): { fileId: string; fileUniqueId: string } | null {
  const photos = (msg as { photo?: Array<{ file_id: string; file_unique_id: string }> })?.photo;
  if (!photos?.length) return null;
  const p = photos[photos.length - 1];
  return { fileId: p.file_id, fileUniqueId: p.file_unique_id };
}

function groupsKeyboard() {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < EFFECT_GROUPS.length; i += 2) {
    rows.push(EFFECT_GROUPS.slice(i, i + 2).map((g) => Markup.button.callback(g, `img:grp:${g}`)));
  }
  return Markup.inlineKeyboard(rows);
}
function effectsKeyboard(group: string) {
  const list = EFFECTS.filter((e) => e.group === group);
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < list.length; i += 3) {
    rows.push(list.slice(i, i + 3).map((e) => Markup.button.callback(`${e.emoji} ${e.label}`, `img:fx:${e.id}`)));
  }
  rows.push([Markup.button.callback('⬅️ رجوع', 'img:back')]);
  return Markup.inlineKeyboard(rows);
}

export const imageEditorPlugin: Plugin = {
  name: 'imageeditor',
  description: 'Fun AI image editor (effects menu + /imagine)',
  commands: [
    { command: 'edit', description: '🎨 تعديل صورة (بالرد على صورة أو أرسلها)' },
    { command: 'imagine', description: '🖼 توليد صورة: /imagine وصف' },
  ],

  register(bot: Telegraf<BotContext>) {
    const editHandler = async (ctx: BotContext) => {
      if (!env.IMAGE_AI_ENABLED || !getImageProvider().isConfigured()) {
        await ctx.reply('🎨 محرّر الصور غير مفعّل (يلزم مفتاح IMAGE_API_KEY).');
        return;
      }
      const msg = ctx.message as { photo?: unknown; reply_to_message?: unknown };
      const own = photoOf(msg);
      const replied = photoOf(msg?.reply_to_message);
      const src = own ?? replied;
      if (!src || !ctx.from || !ctx.chat) {
        await ctx.reply('🎨 أرسل صورة مع الأمر /edit، أو ردّ على صورة بـ /edit');
        return;
      }
      const note = !own && replied ? '\n⚠️ تعدّل صورة شخص آخر — تأكد من موافقته.' : '';
      const sent = await ctx.reply(`🎨 اختر تأثيراً:${note}`, groupsKeyboard());
      pending.set(`${ctx.chat.id}:${sent.message_id}`, {
        fileId: src.fileId,
        fileUniqueId: src.fileUniqueId,
        requesterId: ctx.from.id,
        fromReply: !own,
      });
    };
    bot.command('edit', editHandler);
    bot.command('fun', editHandler);

    bot.action(/^img:grp:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup(effectsKeyboard(ctx.match[1]).reply_markup).catch(() => undefined);
    });
    bot.action('img:back', async (ctx) => {
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup(groupsKeyboard().reply_markup).catch(() => undefined);
    });

    bot.action(/^img:fx:(.+)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const p = pending.get(key);
      const effect = findEffect(ctx.match[1]);
      if (!p || !effect) return void ctx.answerCbQuery('انتهت الصلاحية، أعد /edit').catch(() => undefined);
      if (ctx.from.id !== p.requesterId) return void ctx.answerCbQuery('هذا الطلب ليس لك.').catch(() => undefined);
      await ctx.answerCbQuery(`${effect.emoji} ${effect.label}`).catch(() => undefined);

      const chatId = ctx.chat!.id;
      if (!canUse(chatId)) {
        await ctx.telegram.sendMessage(chatId, '🚦 تم بلوغ الحد اليومي لتعديل الصور.').catch(() => undefined);
        return;
      }

      // Cache hit → resend instantly.
      const cacheKey = `${p.fileUniqueId}:${effect.id}`;
      const cached = resultCache.get(cacheKey);
      if (cached) {
        await ctx.telegram.sendPhoto(chatId, cached, { caption: `${effect.emoji} ${effect.label}` }).catch(() => undefined);
        return;
      }

      const status = await ctx.telegram.sendMessage(chatId, `⏳ جاري تطبيق ${effect.emoji} ${effect.label}...`).catch(() => undefined);
      const telegram = ctx.telegram;

      imageQueue.enqueue(chatId, async () => {
        try {
          const link = await telegram.getFileLink(p.fileId).catch(() => null);
          if (!link) return void edit(telegram, chatId, status, '❌ تعذّر جلب الصورة.');
          const imgRes = await fetch(link.toString());
          if (!imgRes.ok) return void edit(telegram, chatId, status, '❌ تعذّر تحميل الصورة.');
          const buf = Buffer.from(await imgRes.arrayBuffer());

          const out = await getImageProvider().edit(buf, effect.prompt);
          if (!out) return void edit(telegram, chatId, status, '⚠️ تعذّر التعديل الآن، حاول لاحقاً.');

          bump(chatId);
          const sentPhoto = await telegram.sendPhoto(chatId, Input.fromBuffer(out, 'result.png'), {
            caption: `${effect.emoji} ${effect.label}`,
          });
          const fid = (sentPhoto as { photo?: Array<{ file_id: string }> }).photo?.pop()?.file_id;
          if (fid) resultCache.set(cacheKey, fid);
          if (status) await telegram.deleteMessage(chatId, status.message_id).catch(() => undefined);
        } catch (err) {
          log.error({ err }, 'image edit job failed');
          await edit(telegram, chatId, status, '⚠️ حدث خطأ أثناء المعالجة.');
        }
      }, 1, 20);
    });

    // /imagine <prompt> — text-to-image.
    bot.command('imagine', async (ctx) => {
      if (!env.IMAGE_AI_ENABLED || !getImageProvider().isConfigured()) {
        await ctx.reply('🖼 التوليد غير مفعّل (يلزم مفتاح IMAGE_API_KEY).');
        return;
      }
      const prompt = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!prompt) return void ctx.reply('🖼 اكتب وصفاً.\nمثال: /imagine قلعة في الفضاء');
      if (!ctx.chat || !canUse(ctx.chat.id)) return void ctx.reply('🚦 تم بلوغ الحد اليومي.');
      const chatId = ctx.chat.id;
      const telegram = ctx.telegram;
      const status = await ctx.reply('⏳ جاري توليد الصورة...').catch(() => undefined);
      imageQueue.enqueue(chatId, async () => {
        const out = await getImageProvider().generate(prompt);
        if (!out) return void edit(telegram, chatId, status, '⚠️ تعذّر التوليد.');
        bump(chatId);
        await telegram.sendPhoto(chatId, Input.fromBuffer(out, 'img.png'), { caption: `🖼 ${prompt.slice(0, 100)}` }).catch(() => undefined);
        if (status) await telegram.deleteMessage(chatId, status.message_id).catch(() => undefined);
      }, 1, 20);
    });
  },
};

async function edit(
  telegram: BotContext['telegram'],
  chatId: number,
  status: { message_id: number } | undefined,
  text: string,
): Promise<void> {
  if (status) await telegram.editMessageText(chatId, status.message_id, undefined, text).catch(() => undefined);
  else await telegram.sendMessage(chatId, text).catch(() => undefined);
}
