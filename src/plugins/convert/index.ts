import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';
import { convertDocument, CONVERT_TARGETS, type ConvertTarget } from '../../services/office/convert';

const log = createLogger('plugin:convert');
const CONVERT_RE = /^(\/convert|تحويل|حوّل الملف|حول الملف|تحويل الملف)$/i;
const MAX_BYTES = 25 * 1024 * 1024;
const LABEL: Record<ConvertTarget, string> = { pdf: '📄 PDF', docx: '📝 Word', pptx: '📊 PowerPoint' };

interface Pending {
  fileId: string;
  ext: string;
  name: string;
}
const pending = new Map<number, Pending>(); // userId → source file

/** Pull a convertible source (document or photo) from a message. */
function sourceOf(msg: unknown): Pending | null {
  const m = msg as { document?: { file_id: string; file_name?: string; mime_type?: string }; photo?: { file_id: string }[] };
  if (m?.document) {
    const name = m.document.file_name ?? 'file';
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    if (CONVERT_TARGETS[ext]) return { fileId: m.document.file_id, ext, name };
    return null;
  }
  if (m?.photo?.length) {
    return { fileId: m.photo[m.photo.length - 1].file_id, ext: 'jpg', name: 'image.jpg' };
  }
  return null;
}

function targetKeyboard(ext: string) {
  const targets = CONVERT_TARGETS[ext] ?? [];
  return Markup.inlineKeyboard(targets.map((t) => [Markup.button.callback(`تحويل إلى ${LABEL[t]}`, `conv:${t}`)]));
}

async function offer(ctx: BotContext, src: Pending): Promise<void> {
  if (!ctx.from) return;
  pending.set(ctx.from.id, src);
  await ctx.reply(`🔄 الملف: ${src.name}\nاختر الصيغة اللي بدك تحوّل إلها:`, targetKeyboard(src.ext));
}

/** 🔄 Convert documents/images between PDF / Word / PowerPoint via LibreOffice. */
export const convertPlugin: Plugin = {
  name: 'convert',
  description: 'Convert files between PDF, Word, PowerPoint and image→PDF',
  commands: [{ command: 'convert', description: '🔄 تحويل ملف (بالرد عليه): PDF / Word / PowerPoint' }],

  register(bot: Telegraf<BotContext>) {
    // /convert (or «تحويل») as a reply to a file.
    bot.command('convert', async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: unknown }).reply_to_message;
      const src = replied ? sourceOf(replied) : null;
      if (!src) {
        await ctx.reply('🔄 ردّ على ملف (Word / PowerPoint / PDF / صورة) واكتب «تحويل».\nمثال: ردّ على ملف PDF بـ «تحويل» ← اختر Word.');
        return;
      }
      await offer(ctx, src);
    });

    // A file sent (or replied to) with a «تحويل» caption/text.
    bot.on(message('document'), async (ctx, next) => {
      const cap = (ctx.message as { caption?: string }).caption?.trim() ?? '';
      if (!CONVERT_RE.test(cap)) return next();
      const src = sourceOf(ctx.message);
      if (!src) return void ctx.reply('⚠️ نوع الملف غير مدعوم للتحويل.');
      await offer(ctx, src);
    });
    bot.on(message('photo'), async (ctx, next) => {
      const cap = (ctx.message as { caption?: string }).caption?.trim() ?? '';
      if (!CONVERT_RE.test(cap)) return next();
      const src = sourceOf(ctx.message);
      if (src) await offer(ctx, src);
    });

    // Target chosen → download, convert, send.
    bot.action(/^conv:(pdf|docx|pptx)$/, async (ctx) => {
      const src = ctx.from ? pending.get(ctx.from.id) : undefined;
      if (!src) return void ctx.answerCbQuery('انتهت الجلسة، ردّ على الملف واكتب «تحويل» من جديد.').catch(() => undefined);
      const target = ctx.match[1] as ConvertTarget;
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageText(`⏳ جاري التحويل إلى ${LABEL[target]}...`).catch(() => undefined);
      await ctx.sendChatAction('upload_document').catch(() => undefined);
      try {
        const link = await ctx.telegram.getFileLink(src.fileId).catch(() => null);
        if (!link) return void ctx.reply('⚠️ تعذّر جلب الملف.');
        const res = await fetch(link.toString());
        if (!res.ok) return void ctx.reply('⚠️ تعذّر تنزيل الملف.');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) return void ctx.reply('⚠️ الملف كبير جداً (الحد 25MB).');
        const out = await convertDocument(buf, src.ext, target);
        if (!out) {
          await ctx.reply('⚠️ تعذّر التحويل. جرّب ملفاً آخر — بعض ملفات PDF المعقّدة صعبة التحويل.');
          return;
        }
        const base = src.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || 'converted';
        await ctx.replyWithDocument(Input.fromBuffer(out, `${base}.${target}`), {
          caption: `✅ تم التحويل إلى ${LABEL[target]}\n${(out.length / 1024).toFixed(0)}KB`,
        });
        if (ctx.from) pending.delete(ctx.from.id);
      } catch (err) {
        log.error({ err }, 'convert failed');
        await ctx.reply('⚠️ صار خطأ أثناء التحويل.');
      }
    });
  },
};
