import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';
import { env } from '../../config/env';
import { isBotOwner } from '../../utils/permissions';
import {
  isSupportedRef,
  validateReferences,
  validateText,
  syntheticCaption,
  syntheticFilename,
  MAX_REF_CLIPS,
  MAX_REF_SECONDS,
  MAX_TEXT_CHARS,
  MIN_REF_SECONDS,
} from '../../services/voiceclone/policy';
import {
  voiceCloneReady,
  synthesizeVoice,
  queueStatus,
  type EngineError,
} from '../../services/voiceclone/engine';
import {
  createPending,
  approveConsent,
  rejectConsent,
  revokeConsent,
  authorizeGeneration,
  bumpGenCount,
  listForUser,
  listPending,
  refIds,
  STATUS_LABEL,
} from '../../services/voiceclone/consent';

const log = createLogger('plugin:voiceclone');

const MAX_DL_BYTES = 20 * 1024 * 1024; // Telegram getFile cap
const START_RE = /^(?:\/clonevoice|استنساخ صوت|استنساخ الصوت|كلون صوت|استنسخ صوت)$/i;
const DONE_RE = /^(?:\/done|تم|خلص|انتهيت|انتهى)$/i;
const CANCEL_RE = /^(?:\/cancelvoice|الغاء|إلغاء|الغِ)$/i;

// ── Wizard state (in-memory; a lost wizard just restarts, nothing sensitive) ──
interface Ref {
  fileId: string;
  seconds: number;
}
interface Wizard {
  step: 'collect' | 'owner' | 'scope' | 'declare';
  chatId: number;
  voiceOwner?: string;
  scope?: string;
  refs: Ref[];
  at: number;
}
const wizards = new Map<number, Wizard>();
const WIZARD_TTL = 30 * 60 * 1000;

function freshWizard(w: Wizard | undefined): Wizard | undefined {
  if (!w) return undefined;
  if (Date.now() - w.at > WIZARD_TTL) return undefined;
  return w;
}

const totalSeconds = (refs: Ref[]): number => refs.reduce((s, r) => s + (r.seconds || 0), 0);

// ── Helpers ───────────────────────────────────────────────────────────────

async function downloadTo(url: string, dest: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    if (!r.ok || !r.body) return false;
    await pipeline(Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
    return true;
  } catch {
    return false;
  }
}

/** Re-encode + trim a reference clip to <=MAX_REF_SECONDS of OGG/Opus. */
function normalizeRef(input: string, output: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(
      'ffmpeg',
      ['-y', '-i', input, '-t', String(MAX_REF_SECONDS), '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', output],
      { stdio: 'ignore' },
    );
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

const ENGINE_ERR_MSG: Record<EngineError, string> = {
  disabled: '🔇 خدمة استنساخ الصوت غير مفعّلة.',
  unconfigured: '🔧 محرّك الصوت غير مُعدّ بعد (ينقصه الرابط/المفتاح).',
  timeout: '⌛ المحرّك تأخّر كثيراً (المعالجة على CPU بطيئة). جرّب نصاً أقصر لاحقاً.',
  http: '⚠️ المحرّك ردّ بخطأ. حاول لاحقاً.',
  empty: '⚠️ ما رجّع المحرّك أي صوت. جرّب مرجعاً أوضح أو نصاً أقصر.',
  network: '🌐 تعذّر الوصول للمحرّك.',
};

function ownerConfigHint(): string {
  return (
    '🔧 لتشغيل استنساخ الصوت:\n' +
    '1) انشر محرّك Voise على Hugging Face Space (CPU).\n' +
    '2) اضبط: <code>VOICECLONE_ENABLED=true</code>،\n' +
    '   <code>VOICE_ENGINE_URL</code>، <code>VOICE_ENGINE_SECRET</code>.\n' +
    'التفاصيل في ملف VOICECLONE.md.'
  );
}

// ── Wizard flow ─────────────────────────────────────────────────────────────

async function startWizard(ctx: BotContext): Promise<void> {
  if (!ctx.from) return;
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('🔒 استنساخ الصوت يتم في الخاص فقط (حفاظاً على خصوصية التسجيلات). راسلني على الخاص واكتب /clonevoice').catch(() => undefined);
    return;
  }
  if (!voiceCloneReady()) {
    await ctx
      .reply(isBotOwner(ctx.from.id) ? ownerConfigHint() : '🔇 خدمة استنساخ الصوت غير مفعّلة حالياً.', {
        parse_mode: 'HTML',
      })
      .catch(() => undefined);
    return;
  }
  wizards.set(ctx.from.id, { step: 'collect', chatId: ctx.chat.id, refs: [], at: Date.now() });
  await ctx
    .reply(
      '🎙 <b>استنساخ صوت — بموافقة موثّقة فقط</b>\n' +
        '✦ ┈┈┈┈┈┈┈┈ ✦\n' +
        `1️⃣ أرسل الآن <b>تسجيلات صوتية</b> لصاحب الصوت (رسائل صوتية Voice). يفضّل ≥ ${MIN_REF_SECONDS} ثوانٍ، حتى ${MAX_REF_CLIPS} مقاطع.\n` +
        'عند الانتهاء اكتب <b>/done</b> أو «تم».\n' +
        '❗️ لا تُرسل صوت شخص بدون إذنه الصريح. كل ناتج سيُوسم أنه «صوت مُولّد بالذكاء الاصطناعي».\n' +
        'للإلغاء: /cancelvoice',
      { parse_mode: 'HTML' },
    )
    .catch(() => undefined);
}

async function finalize(ctx: BotContext, w: Wizard): Promise<void> {
  if (!ctx.from) return;
  const declaration =
    `أقرّ أنا (${ctx.from.id}) بأن صاحب الصوت «${w.voiceOwner}» موافق على استنساخ صوته ` +
    `للغرض التالي: ${w.scope}. الموافقة قابلة للسحب.`;
  let id: number;
  try {
    id = await createPending({
      requesterId: BigInt(ctx.from.id),
      chatId: BigInt(w.chatId),
      voiceOwner: w.voiceOwner!,
      scope: w.scope!,
      revocable: true,
      declaration,
      refFileIds: w.refs.map((r) => r.fileId),
      refSeconds: totalSeconds(w.refs),
    });
  } catch (err) {
    log.error({ err }, 'createPending failed');
    await ctx.reply('⚠️ تعذّر حفظ الطلب. حاول لاحقاً.').catch(() => undefined);
    return;
  }
  wizards.delete(ctx.from.id);
  await ctx
    .reply(
      `📨 تم إرسال الطلب #${id} للمراجعة.\n` +
        '⏳ لن يتم إنتاج أي صوت قبل موافقة مالك البوت.\n' +
        'تابع حالتك عبر /myvoices',
    )
    .catch(() => undefined);

  // Notify every owner with inline review buttons.
  const who = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.first_name ?? ''}`.trim() || String(ctx.from.id);
  const text =
    '🆕 <b>طلب استنساخ صوت للمراجعة</b>\n' +
    `#${id}\n` +
    `👤 مُقدّم الطلب: ${escapeHtml(who)} (<code>${ctx.from.id}</code>)\n` +
    `🎙 صاحب الصوت: ${escapeHtml(w.voiceOwner ?? '')}\n` +
    `🎯 الغرض: ${escapeHtml(w.scope ?? '')}\n` +
    `📎 مقاطع مرجعية: ${w.refs.length} · ~${totalSeconds(w.refs).toFixed(0)}s\n` +
    '⚠️ تأكّد أن صاحب الصوت موافق فعلاً قبل الاعتماد.';
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✅ اعتماد', `vc:ok:${id}`), Markup.button.callback('❌ رفض', `vc:no:${id}`)],
  ]);
  for (const owner of env.OWNER_IDS) {
    await ctx.telegram.sendMessage(Number(owner), text, { parse_mode: 'HTML', ...kb }).catch(() => undefined);
  }
}

/** Handle a text message while a wizard is active. Returns true if consumed. */
async function wizardText(ctx: BotContext, w: Wizard, text: string): Promise<boolean> {
  w.at = Date.now();
  if (CANCEL_RE.test(text)) {
    wizards.delete(ctx.from!.id);
    await ctx.reply('✖️ تم إلغاء الطلب.').catch(() => undefined);
    return true;
  }
  if (w.step === 'collect') {
    if (!DONE_RE.test(text)) {
      await ctx.reply('🎙 أرسل التسجيلات الصوتية، وعند الانتهاء اكتب /done — أو /cancelvoice للإلغاء.').catch(() => undefined);
      return true;
    }
    const v = validateReferences(w.refs.length, totalSeconds(w.refs));
    if (!v.ok) {
      await ctx
        .reply(v.error === 'noclips' ? '⚠️ لم ترسل أي تسجيل بعد. أرسل رسالة صوتية أولاً.' : `⚠️ التسجيلات قصيرة جداً. أرسل ما مجموعه ≥ ${MIN_REF_SECONDS} ثوانٍ.`)
        .catch(() => undefined);
      return true;
    }
    w.step = 'owner';
    await ctx.reply('✍️ اكتب اسم/هوية <b>صاحب الصوت</b> (الشخص الذي يملك هذا الصوت):', { parse_mode: 'HTML' }).catch(() => undefined);
    return true;
  }
  if (w.step === 'owner') {
    w.voiceOwner = text.slice(0, 120);
    w.step = 'scope';
    await ctx.reply('🎯 اكتب <b>الغرض</b> من الاستخدام (نطاق الموافقة)، مثال: «قراءة كتابي الصوتي الخاص».', { parse_mode: 'HTML' }).catch(() => undefined);
    return true;
  }
  if (w.step === 'scope') {
    w.scope = text.slice(0, 300);
    w.step = 'declare';
    await ctx
      .reply(
        '🧾 للتأكيد، اكتب إقراراً صريحاً يتضمّن موافقة صاحب الصوت، مثل:\n' +
          `«أؤكد أن ${w.voiceOwner} موافق على استنساخ صوته لغرض ${w.scope}، والموافقة قابلة للسحب.»\n` +
          'أرسل الإقرار الآن، أو /cancelvoice.',
      )
      .catch(() => undefined);
    return true;
  }
  if (w.step === 'declare') {
    const d = text.trim();
    if (d.length < 12) {
      await ctx.reply('⚠️ الإقرار قصير جداً. اكتب جملة موافقة واضحة.').catch(() => undefined);
      return true;
    }
    await finalize(ctx, w);
    return true;
  }
  return false;
}

/** Add an incoming audio/voice as a reference while collecting. */
async function collectRef(ctx: BotContext, w: Wizard, fileId: string, seconds: number, mime?: string, name?: string): Promise<void> {
  w.at = Date.now();
  if (!isSupportedRef(mime, name)) {
    await ctx.reply('⚠️ صيغة غير مدعومة. أرسل رسالة صوتية أو ملف صوتي (ogg/mp3/m4a/wav).').catch(() => undefined);
    return;
  }
  if (w.refs.length >= MAX_REF_CLIPS) {
    await ctx.reply(`⚠️ وصلت للحد الأقصى (${MAX_REF_CLIPS} مقاطع). اكتب /done للمتابعة.`).catch(() => undefined);
    return;
  }
  w.refs.push({ fileId, seconds: seconds || 0 });
  const tot = totalSeconds(w.refs);
  await ctx
    .reply(`✅ أُضيف مقطع (${w.refs.length}) · المجموع ~${tot.toFixed(0)}s.\nأرسل المزيد أو اكتب /done.`)
    .catch(() => undefined);
}

// ── Generation ───────────────────────────────────────────────────────────────

async function generate(ctx: BotContext, id: number, rawText: string): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  if (!voiceCloneReady()) {
    await ctx.reply('🔇 خدمة استنساخ الصوت غير مفعّلة حالياً.').catch(() => undefined);
    return;
  }
  const tv = validateText(rawText);
  if (!tv.ok) {
    await ctx.reply(tv.error === 'empty' ? '✍️ اكتب النص بعد رقم الطلب: /speak <رقم> <النص>' : `⚠️ النص طويل (الحد ${MAX_TEXT_CHARS} حرف).`).catch(() => undefined);
    return;
  }
  const auth = await authorizeGeneration(id, BigInt(ctx.from.id));
  if (!auth.ok) {
    const MSG: Record<string, string> = {
      notfound: '⚠️ لا يوجد طلب بهذا الرقم.',
      pending: '⏳ الطلب ما زال بانتظار الموافقة.',
      rejected: '❌ هذا الطلب مرفوض.',
      revoked: '🚫 تم سحب الموافقة لهذا الطلب.',
      notrequester: '🔒 هذا الطلب ليس لك.',
      unknown: '⚠️ حالة الطلب غير صالحة.',
    };
    await ctx.reply(MSG[auth.reason] || MSG.unknown).catch(() => undefined);
    return;
  }

  const refList = refIds(auth.row);
  if (!refList.length) {
    await ctx.reply('⚠️ لا توجد مقاطع مرجعية محفوظة لهذا الطلب.').catch(() => undefined);
    return;
  }

  const q = queueStatus();
  const queued = q.active + q.waiting > 0;
  const status = await ctx
    .reply(queued ? '⏳ في الطابور… المعالجة على CPU تأخذ وقتاً.' : '🎧 جاري توليد الصوت… ⏳')
    .catch(() => undefined);
  const statusId = (status as { message_id?: number } | undefined)?.message_id;
  await ctx.sendChatAction('record_voice').catch(() => undefined);
  const edit = (t: string): Promise<unknown> =>
    statusId ? ctx.telegram.editMessageText(ctx.chat!.id, statusId, undefined, t).catch(() => undefined) : ctx.reply(t).catch(() => undefined);

  const dir = await mkdtemp(join(tmpdir(), 'vclone-'));
  const cleanup = (): Promise<unknown> => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const rawPath = join(dir, 'ref.raw');
  const refPath = join(dir, 'ref.ogg');
  try {
    const link = await ctx.telegram.getFileLink(refList[0]).catch(() => null);
    if (!link) return void (await edit('⚠️ تعذّر جلب المقطع المرجعي.'));
    if (!(await downloadTo(link.toString(), rawPath))) return void (await edit('⚠️ تعذّر تنزيل المقطع المرجعي.'));
    if ((await stat(rawPath)).size > MAX_DL_BYTES) return void (await edit('⚠️ المقطع المرجعي كبير جداً.'));

    // Normalize/trim; if ffmpeg is unavailable fall back to the raw bytes.
    let refBuf: Buffer;
    let refName = 'ref.ogg';
    if (await normalizeRef(rawPath, refPath)) {
      refBuf = await readFile(refPath);
    } else {
      refBuf = await readFile(rawPath);
      refName = 'ref.audio';
    }

    const res = await synthesizeVoice({ text: tv.text, ref: refBuf, refName });
    if ('error' in res) {
      await edit(ENGINE_ERR_MSG[res.error] || ENGINE_ERR_MSG.http);
      return;
    }

    await ctx
      .replyWithVoice(Input.fromBuffer(res.ogg, syntheticFilename(auth.row.voiceOwner, auth.row.genCount + 1)), {
        caption: syntheticCaption(auth.row.voiceOwner, res.seconds),
      })
      .catch(() => undefined);
    await bumpGenCount(id);
    if (statusId) await ctx.telegram.deleteMessage(ctx.chat.id, statusId).catch(() => undefined);
  } catch (err) {
    log.error({ err }, 'voiceclone generate failed');
    await edit('⚠️ صار خطأ أثناء التوليد.');
  } finally {
    await cleanup();
  }
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 🎙 Consent-gated voice cloning. A user submits reference recordings + a consent
 * declaration (in private chat); a bot OWNER must approve before any synthesis.
 * Every generated clip is sent clearly labeled as AI-synthesized. Runs only when
 * VOICECLONE_ENABLED and the external engine (VOICE_ENGINE_URL/SECRET) are set.
 */
export const voiceclonePlugin: Plugin = {
  name: 'voiceclone',
  description: 'Consent-gated voice cloning via an external TTS engine (owner-approved, labeled synthetic)',
  commands: [
    { command: 'clonevoice', description: '🎙 طلب استنساخ صوت (بموافقة، في الخاص)' },
    { command: 'speak', description: '🔊 توليد نص بصوت معتمد: /speak <رقم> <النص>' },
    { command: 'myvoices', description: '📋 طلبات استنساخ الصوت الخاصة بك' },
    { command: 'revokevoice', description: '🚫 سحب موافقة: /revokevoice <رقم>' },
    { command: 'voicequeue', description: '🗂 الطلبات المعلّقة (للمالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('clonevoice', (ctx) => startWizard(ctx));
    bot.hears(START_RE, async (ctx, next) => {
      if (ctx.chat?.type === 'private') return void startWizard(ctx);
      return next();
    });

    // /speak <id> <text>
    bot.command('speak', async (ctx) => {
      const raw = (ctx.message as { text?: string }).text ?? '';
      const m = raw.replace(/^\/speak(?:@\S+)?\s*/i, '');
      const mm = m.match(/^#?(\d+)\s+([\s\S]+)$/);
      if (!mm) {
        await ctx.reply('🔊 الصيغة: /speak <رقم الطلب> <النص>\nمثال: /speak 3 مرحبا كيف حالك').catch(() => undefined);
        return;
      }
      await generate(ctx, Number(mm[1]), mm[2]);
    });

    bot.command('myvoices', async (ctx) => {
      if (!ctx.from) return;
      const rows = await listForUser(BigInt(ctx.from.id)).catch(() => []);
      if (!rows.length) return void ctx.reply('📋 لا توجد طلبات. ابدأ عبر /clonevoice').catch(() => undefined);
      const body = rows
        .map((r) => `#${r.id} · ${r.voiceOwner} · ${STATUS_LABEL[r.status as keyof typeof STATUS_LABEL] ?? r.status}`)
        .join('\n');
      await ctx.reply(`📋 طلباتك:\n${body}\n\nللتوليد: /speak <رقم> <النص>`).catch(() => undefined);
    });

    bot.command('voicequeue', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return void ctx.reply('🔒 للمالك فقط.').catch(() => undefined);
      const rows = await listPending().catch(() => []);
      if (!rows.length) return void ctx.reply('🗂 لا طلبات معلّقة.').catch(() => undefined);
      for (const r of rows) {
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback('✅ اعتماد', `vc:ok:${r.id}`), Markup.button.callback('❌ رفض', `vc:no:${r.id}`)],
        ]);
        await ctx
          .reply(`#${r.id} · 🎙 ${r.voiceOwner}\n🎯 ${r.scope}\n📎 ${r.refCount} مقاطع · ~${r.refSeconds.toFixed(0)}s`, kb)
          .catch(() => undefined);
      }
    });

    bot.command('revokevoice', async (ctx) => {
      if (!ctx.from) return;
      const raw = (ctx.message as { text?: string }).text ?? '';
      const id = Number(raw.replace(/^\/revokevoice(?:@\S+)?\s*/i, '').match(/\d+/)?.[0]);
      if (!id) return void ctx.reply('🚫 الصيغة: /revokevoice <رقم الطلب>').catch(() => undefined);
      const res = await revokeConsent(id, BigInt(ctx.from.id), 'revoked by user/owner');
      if (!res.ok) {
        const MSG: Record<string, string> = {
          notfound: '⚠️ لا يوجد طلب بهذا الرقم.',
          notallowed: '🔒 لا تملك صلاحية سحب هذا الطلب.',
          alreadygone: 'ℹ️ الطلب مسحوب/مرفوض أصلاً.',
        };
        return void ctx.reply(MSG[res.error] || '⚠️ تعذّر السحب.').catch(() => undefined);
      }
      await ctx.reply(`🚫 تم سحب الموافقة للطلب #${id}. لن يُنتَج صوت بعد الآن.`).catch(() => undefined);
    });

    // Owner approve / reject.
    bot.action(/^vc:(ok|no):(\d+)$/, async (ctx) => {
      const uid = ctx.from?.id;
      if (!uid || !isBotOwner(uid)) return void ctx.answerCbQuery('🔒 للمالك فقط.').catch(() => undefined);
      const kind = ctx.match[1];
      const id = Number(ctx.match[2]);
      if (kind === 'ok') {
        const res = await approveConsent(id, BigInt(uid));
        if (!res.ok) return void ctx.answerCbQuery(res.error === 'notpending' ? 'سبق التعامل معه.' : 'تعذّر.').catch(() => undefined);
        await ctx.answerCbQuery('✅ اعتُمد').catch(() => undefined);
        await ctx.editMessageText(`✅ اعتُمد الطلب #${id}.`).catch(() => undefined);
        await ctx.telegram
          .sendMessage(Number(res.row.requesterId), `✅ تم اعتماد طلبك #${id}. وَلّد صوتاً عبر: /speak ${id} <النص>`)
          .catch(() => undefined);
      } else {
        const res = await rejectConsent(id, BigInt(uid), 'rejected by owner');
        if (!res.ok) return void ctx.answerCbQuery(res.error === 'notpending' ? 'سبق التعامل معه.' : 'تعذّر.').catch(() => undefined);
        await ctx.answerCbQuery('❌ رُفض').catch(() => undefined);
        await ctx.editMessageText(`❌ رُفض الطلب #${id}.`).catch(() => undefined);
        await ctx.telegram.sendMessage(Number(res.row.requesterId), `❌ تم رفض طلبك #${id}.`).catch(() => undefined);
      }
    });

    // Reference collection (voice / audio / audio-document) — only while a wizard
    // is active in this user's private chat; otherwise pass through untouched.
    const wizOf = (ctx: BotContext): Wizard | undefined => {
      if (ctx.chat?.type !== 'private' || !ctx.from) return undefined;
      const w = freshWizard(wizards.get(ctx.from.id));
      if (!w) wizards.delete(ctx.from.id);
      return w && w.step === 'collect' ? w : undefined;
    };

    bot.on(message('voice'), async (ctx, next) => {
      const w = wizOf(ctx);
      if (!w) return next();
      const v = (ctx.message as { voice: { file_id: string; duration?: number; mime_type?: string } }).voice;
      await collectRef(ctx, w, v.file_id, v.duration ?? 0, v.mime_type, 'voice.ogg');
    });
    bot.on(message('audio'), async (ctx, next) => {
      const w = wizOf(ctx);
      if (!w) return next();
      const a = (ctx.message as { audio: { file_id: string; duration?: number; mime_type?: string; file_name?: string } }).audio;
      await collectRef(ctx, w, a.file_id, a.duration ?? 0, a.mime_type, a.file_name);
    });
    bot.on(message('document'), async (ctx, next) => {
      const w = wizOf(ctx);
      if (!w) return next();
      const d = (ctx.message as { document: { file_id: string; mime_type?: string; file_name?: string } }).document;
      if (!isSupportedRef(d.mime_type, d.file_name)) return next(); // not audio → let other plugins handle
      await collectRef(ctx, w, d.file_id, 0, d.mime_type, d.file_name);
    });

    // Wizard text steps (owner/scope/declaration, /done, /cancelvoice).
    bot.on(message('text'), async (ctx, next) => {
      if (ctx.chat?.type !== 'private' || !ctx.from) return next();
      const w = freshWizard(wizards.get(ctx.from.id));
      if (!w) {
        wizards.delete(ctx.from.id);
        return next();
      }
      const text = (ctx.message as { text: string }).text;
      // Let the explicit start trigger restart cleanly instead of being eaten.
      if (START_RE.test(text)) return next();
      const consumed = await wizardText(ctx, w, text);
      if (!consumed) return next();
    });
  },
};
