import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';
import { largestPhoto } from '../sticker/logic';
import { createPdf } from '../../services/pdf/render';
import { createDocx } from '../../services/office/docx';
import { createPptx } from '../../services/office/pptx';
import { DOC_TYPES } from '../../services/pdf/themes';
import { startPdf, getPdf, clearPdf, parseCoverFields, type PdfState } from './state';

const log = createLogger('plugin:pdf');
const DONE_RE = /^(تم|خلص|انهاء|إنهاء|done|generate|انشئ|أنشئ)$/i;
const MAX_IMG_BYTES = 8 * 1024 * 1024;

type OutFormat = 'pdf' | 'docx' | 'pptx';
const formatKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📄 PDF', 'pdff:pdf')],
    [Markup.button.callback('📝 Word', 'pdff:docx')],
    [Markup.button.callback('📊 PowerPoint', 'pdff:pptx')],
  ]);

const typeKeyboard = () =>
  Markup.inlineKeyboard(
    [...DOC_TYPES.map((d) => Markup.button.callback(d.label, `pdft:${d.key}`)), Markup.button.callback('✏️ نوع مخصص', 'pdft:__custom')]
      .reduce<ReturnType<typeof Markup.button.callback>[][]>((rows, btn, i) => {
        if (i % 2 === 0) rows.push([btn]);
        else rows[rows.length - 1].push(btn);
        return rows;
      }, []),
  );

const coverKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📇 أضف معلومات الغلاف', 'pdfc:add')],
    [Markup.button.callback('⏭ تخطّي', 'pdfc:skip')],
  ]);

/** 📄 Smart PDF Creator — an interactive wizard that builds a styled PDF. */
export const pdfPlugin: Plugin = {
  name: 'pdf',
  description: 'Interactive professional PDF creator (Arabic + English)',
  commands: [
    { command: 'pdf', description: '📄 أنشئ مستند احترافي: PDF / Word / PowerPoint' },
    { command: 'pdfcancel', description: '❌ إلغاء إنشاء المستند' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('pdf', async (ctx) => {
      if (!ctx.from) return;
      startPdf(ctx.from.id, ctx.chat!.id);
      await ctx.reply('📑 منشئ المستندات الذكي (PDF / Word / PowerPoint)\n\nما عنوان المستند؟ اكتبه الآن.\n(للإلغاء: /pdfcancel)');
    });

    bot.command('pdfcancel', async (ctx) => {
      if (!ctx.from) return;
      clearPdf(ctx.from.id);
      await ctx.reply('❌ أُلغي إنشاء الـ PDF.');
    });

    // Document type chosen.
    bot.action(/^pdft:(.+)$/, async (ctx) => {
      const st = ctx.from ? getPdf(ctx.from.id) : undefined;
      if (!st || st.step !== 'type') return void ctx.answerCbQuery().catch(() => undefined);
      const key = ctx.match[1];
      await ctx.answerCbQuery().catch(() => undefined);
      if (key === '__custom') {
        st.step = 'customtype';
        return void ctx.editMessageText('✏️ اكتب نوع المستند المخصص:').catch(() => undefined);
      }
      st.typeKey = key;
      st.step = 'cover';
      const label = DOC_TYPES.find((d) => d.key === key)?.label ?? key;
      await ctx.editMessageText(`نوع المستند: ${label} ✅`).catch(() => undefined);
      await ctx.reply('هل تريد إضافة معلومات الغلاف؟', coverKeyboard());
    });

    // Cover add / skip.
    bot.action('pdfc:add', async (ctx) => {
      const st = ctx.from ? getPdf(ctx.from.id) : undefined;
      if (!st) return void ctx.answerCbQuery().catch(() => undefined);
      st.step = 'cover';
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageText(
        '📇 أرسل معلومات الغلاف بصيغة «الحقل: القيمة»، كل حقل بسطر. مثال:\n\n' +
          'الاسم: محمد أحمد\nالرقم الجامعي: 20211234\nالجامعة: ...\nالكلية: ...\nالتخصص: ...\nالمادة: ...\nالدكتور: ...\n\n' +
          'اترك أي حقل لا تريده. أرسل الرسالة عندما تجهز.',
      ).catch(() => undefined);
    });
    bot.action('pdfc:skip', async (ctx) => {
      const st = ctx.from ? getPdf(ctx.from.id) : undefined;
      if (!st) return void ctx.answerCbQuery().catch(() => undefined);
      st.step = 'content';
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageText('تم التخطّي ⏭').catch(() => undefined);
      await promptContent(ctx);
    });

    // Output format chosen → generate that file.
    bot.action(/^pdff:(pdf|docx|pptx)$/, async (ctx) => {
      const st = ctx.from ? getPdf(ctx.from.id) : undefined;
      if (!st) return void ctx.answerCbQuery('انتهت الجلسة، ابدأ /pdf').catch(() => undefined);
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageText(`الصيغة: ${{ pdf: '📄 PDF', docx: '📝 Word', pptx: '📊 PowerPoint' }[ctx.match[1]]} ✅`).catch(() => undefined);
      await generate(ctx, st, ctx.match[1] as OutFormat);
    });

    // Photos during the content step → embed as figures.
    bot.on(message('photo'), async (ctx, next) => {
      const st = ctx.from ? getPdf(ctx.from.id) : undefined;
      if (!st || st.step !== 'content') return next();
      await captureImage(ctx, st);
    });

    // TXT / Markdown documents during the content step.
    bot.on(message('document'), async (ctx, next) => {
      const st = ctx.from ? getPdf(ctx.from.id) : undefined;
      if (!st || st.step !== 'content') return next();
      const doc = ctx.message.document;
      const name = doc.file_name ?? '';
      if (!/\.(txt|md|markdown|text)$/i.test(name) && !/^text\//.test(doc.mime_type ?? '')) {
        return void ctx.reply('📄 أرسل ملف نصي (.txt أو .md) أو اكتب المحتوى مباشرة.');
      }
      const text = await downloadText(ctx, doc.file_id);
      if (text) {
        st.contentParts.push(text);
        await ctx.reply('✅ أُضيف محتوى الملف. أرسل المزيد أو اكتب «تم».');
      } else await ctx.reply('⚠️ تعذّر قراءة الملف.');
    });

    // The wizard's text pipeline.
    bot.on(message('text'), async (ctx, next) => {
      const st = ctx.from ? getPdf(ctx.from.id) : undefined;
      if (!st) return next();
      const text = ctx.message.text;
      if (text.startsWith('/')) return next(); // let commands through

      if (st.step === 'title') {
        st.title = text.trim().slice(0, 120);
        st.step = 'type';
        await ctx.reply(`📄 العنوان: «${st.title}»\n\nما نوع المستند؟`, typeKeyboard());
        return;
      }
      if (st.step === 'customtype') {
        st.customType = text.trim().slice(0, 40);
        st.typeKey = 'plain';
        st.step = 'cover';
        await ctx.reply(`نوع المستند: ${st.customType} ✅`);
        await ctx.reply('هل تريد إضافة معلومات الغلاف؟', coverKeyboard());
        return;
      }
      if (st.step === 'cover') {
        st.cover = parseCoverFields(text);
        st.step = 'content';
        await ctx.reply(st.cover.length ? `✅ حُفظت ${st.cover.length} معلومة للغلاف.` : 'لم أجد حقولاً، سنكمل بدون غلاف مفصّل.');
        await promptContent(ctx);
        return;
      }
      if (st.step === 'content') {
        if (DONE_RE.test(text.trim())) {
          st.step = 'format';
          await ctx.reply('بأي صيغة تريد المستند؟', formatKeyboard());
          return;
        }
        st.contentParts.push(text);
        return; // consumed silently to avoid spamming while collecting
      }
      return next();
    });
  },
};

async function promptContent(ctx: BotContext): Promise<void> {
  await ctx.reply(
    '✍️ أرسل الآن محتوى المستند:\n' +
      '• رسالة طويلة أو عدة رسائل\n' +
      '• أو ملف .txt / .md\n' +
      '• أو صور (تُدرج في المستند)\n\n' +
      'يمكنك استخدام # للعناوين و - للقوائم و | للجداول.\n' +
      'عند الانتهاء اكتب: «تم» ✅',
  );
}

async function captureImage(ctx: BotContext, st: PdfState): Promise<void> {
  const photo = largestPhoto(ctx.message);
  if (!photo) return;
  const link = await ctx.telegram.getFileLink(photo.fileId).catch(() => null);
  if (!link) return void ctx.reply('⚠️ تعذّر جلب الصورة.');
  const res = await fetch(link.toString()).catch(() => null);
  if (!res?.ok) return void ctx.reply('⚠️ تعذّر تنزيل الصورة.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMG_BYTES) return void ctx.reply('⚠️ الصورة كبيرة جداً.');
  const caption = (ctx.message as { caption?: string }).caption?.trim();
  st.images.push({ dataUri: `data:image/jpeg;base64,${buf.toString('base64')}`, caption });
  await ctx.reply(`🖼️ أُضيفت الصورة (${st.images.length}). أرسل المزيد أو اكتب «تم».`);
}

async function downloadText(ctx: BotContext, fileId: string): Promise<string | null> {
  const link = await ctx.telegram.getFileLink(fileId).catch(() => null);
  if (!link) return null;
  const res = await fetch(link.toString()).catch(() => null);
  if (!res?.ok) return null;
  return (await res.text()).slice(0, 100_000);
}

async function generate(ctx: BotContext, st: PdfState, format: OutFormat = 'pdf'): Promise<void> {
  if (!ctx.from) return;
  const content = st.contentParts.join('\n\n').trim();
  if (!content && !st.images.length) {
    await ctx.reply('❌ لا يوجد محتوى بعد. أرسل نصاً أو صوراً ثم اكتب «تم».');
    return;
  }
  await ctx.reply('⏳ جاري إنشاء المستند بتصميم احترافي...');
  await ctx.sendChatAction('upload_document').catch(() => undefined);
  const date = new Date().toLocaleDateString('en-GB');
  const req = {
    title: st.title || 'مستند',
    typeKey: st.typeKey || 'plain',
    customType: st.customType,
    cover: st.cover,
    content,
    images: st.images,
    date,
  };
  const spec: Record<OutFormat, { ext: string; icon: string; build: () => Promise<Buffer> }> = {
    pdf: { ext: 'pdf', icon: '📄', build: () => createPdf(req) },
    docx: { ext: 'docx', icon: '📝', build: () => createDocx(req) },
    pptx: { ext: 'pptx', icon: '📊', build: () => createPptx(req) },
  };
  const { ext, icon, build } = spec[format];
  try {
    const buf = await build();
    const safe = (st.title || 'document').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    await ctx.replyWithDocument(Input.fromBuffer(buf, `${safe}.${ext}`), {
      caption: `✅ تم إنشاء «${st.title}»\n${icon} ${(buf.length / 1024).toFixed(0)}KB`,
    });
    clearPdf(ctx.from.id);
  } catch (err) {
    log.error({ err, format }, 'document generation failed');
    const reason = err instanceof Error ? err.message : String(err);
    const hint =
      format === 'pdf' && /Chromium|Executable|launch|browserType/i.test(reason)
        ? '\n\n⚠️ المتصفح (Chromium) غير مثبّت على الخادم — لازم يُثبّت لإنشاء الـ PDF.'
        : '';
    await ctx.reply(`⚠️ تعذّر إنشاء المستند.\n\nالسبب: ${reason.slice(0, 200)}${hint}`);
  }
}
