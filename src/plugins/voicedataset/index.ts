import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import { message } from 'telegraf/filters';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:voicedataset');

// Telegram bot getFile cap (per file). Cloud bot upload cap is ~50MB, so keep the
// archive comfortably under it.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 45 * 1024 * 1024;
const MAX_CLIPS = 500;
const SESSION_TTL = 60 * 60 * 1000;

const START_RE = /^(?:\/collectvoices|جمع فويسات|تجميع الفويسات|اجمع الفويسات|داتاسيت صوت|داتاسيت الفويسات)$/i;
const DONE_RE = /^(?:\/buildzip|\/donevoices|\/done|تم|خلص|انتهيت|انهاء|جهّز|جهز)$/i;
const MERGE_RE = /^(?:\/buildmerge|\/mergevoices|دمج|ادمج|دمج الفويسات|ادمجهم)$/i;
const CANCEL_RE = /^(?:\/cancelcollect|الغاء|إلغاء|الغِ)$/i;

// A merged voice note is sent via the bot, so keep it under the upload cap.
const MAX_MERGE_BYTES = 48 * 1024 * 1024;

interface Clip {
  fileId: string;
  ext: string;
  seconds: number;
}
interface Session {
  clips: Clip[];
  at: number;
  statusId?: number;
  lastEdit: number;
}
const sessions = new Map<number, Session>();

function freshSession(s: Session | undefined): Session | undefined {
  if (!s) return undefined;
  if (Date.now() - s.at > SESSION_TTL) return undefined;
  return s;
}

/** Pull a collectible audio clip (voice / audio / audio-document) from a message. */
function clipFromMessage(msg: unknown): Clip | null {
  const m = msg as {
    voice?: { file_id: string; duration?: number };
    audio?: { file_id: string; duration?: number; file_name?: string; mime_type?: string };
    document?: { file_id: string; file_name?: string; mime_type?: string };
  };
  if (m?.voice) return { fileId: m.voice.file_id, ext: 'ogg', seconds: m.voice.duration ?? 0 };
  if (m?.audio) {
    const ext = (m.audio.file_name?.split('.').pop() || extFromMime(m.audio.mime_type) || 'mp3').toLowerCase();
    return { fileId: m.audio.file_id, ext, seconds: m.audio.duration ?? 0 };
  }
  if (m?.document && isAudioDoc(m.document.mime_type, m.document.file_name)) {
    const ext = (m.document.file_name?.split('.').pop() || extFromMime(m.document.mime_type) || 'ogg').toLowerCase();
    return { fileId: m.document.file_id, ext, seconds: 0 };
  }
  return null;
}

function extFromMime(mime?: string): string | null {
  const m = (mime ?? '').toLowerCase();
  if (/ogg|opus/.test(m)) return 'ogg';
  if (/mpeg|mp3/.test(m)) return 'mp3';
  if (/mp4|m4a|aac/.test(m)) return 'm4a';
  if (/wav/.test(m)) return 'wav';
  if (/flac/.test(m)) return 'flac';
  return null;
}
function isAudioDoc(mime?: string, name?: string): boolean {
  if (/^audio\//i.test(mime ?? '')) return true;
  return /\.(ogg|oga|opus|mp3|m4a|aac|wav|flac)$/i.test(name ?? '');
}

const safeExt = (e: string): string => (/^[a-z0-9]{1,5}$/i.test(e) ? e.toLowerCase() : 'bin');

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

/** Zip a folder; fall back to tar.gz if `zip` is unavailable. Returns the archive path or null. */
function makeArchive(cwd: string, folder: string): Promise<string | null> {
  const tryCmd = (cmd: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      const p = spawn(cmd, args, { cwd, stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  return (async () => {
    // -0 = store (audio is already compressed, so skip the slow deflate pass).
    if (await tryCmd('zip', ['-r', '-0', '-q', 'dataset.zip', folder])) return join(cwd, 'dataset.zip');
    if (await tryCmd('tar', ['-czf', 'dataset.tar.gz', folder])) return join(cwd, 'dataset.tar.gz');
    return null;
  })();
}

/** Run ffmpeg with the given args. Resolves false on any failure. */
function ffmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/** Normalize any clip to a uniform OGG/Opus (mono, 48k) so clips concat cleanly. */
const normalizeToOgg = (input: string, output: string): Promise<boolean> =>
  ffmpeg(['-i', input, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', output]);

/** Concatenate a list of (uniform) clips into one OGG/Opus voice note. */
const concatToOgg = (listPath: string, output: string): Promise<boolean> =>
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libopus', '-b:a', '96k', output]);

async function startSession(ctx: BotContext): Promise<void> {
  if (!ctx.from) return;
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('🔒 جمع الفويسات بالخاص فقط. راسلني بالخاص واكتب /collectvoices').catch(() => undefined);
    return;
  }
  const status = await ctx
    .reply(
      '🎙 <b>جمع الفويسات → ملف مضغوط</b>\n' +
        '✦ ┈┈┈┈┈┈┈┈ ✦\n' +
        'أرسل الآن كل الرسائل الصوتية (أو ملفات صوتية) اللي بدك تجمّعها.\n' +
        `الحد الأقصى ${MAX_CLIPS} مقطع.\n` +
        'لما تخلّص اختر:\n' +
        '• <b>/buildzip</b> (أو «تم») → ملف مضغوط فيهم كلهم.\n' +
        '• <b>/buildmerge</b> (أو «دمج») → تسجيل واحد مدموج.\n' +
        'للإلغاء: /cancelcollect',
      { parse_mode: 'HTML' },
    )
    .catch(() => undefined);
  sessions.set(ctx.from.id, {
    clips: [],
    at: Date.now(),
    statusId: (status as { message_id?: number } | undefined)?.message_id,
    lastEdit: Date.now(),
  });
}

async function addClip(ctx: BotContext, s: Session, clip: Clip): Promise<void> {
  if (s.clips.length >= MAX_CLIPS) {
    if (Date.now() - s.lastEdit > 3000) {
      s.lastEdit = Date.now();
      await ctx.reply(`⚠️ وصلت الحد (${MAX_CLIPS}). اكتب /buildzip للتجهيز.`).catch(() => undefined);
    }
    return;
  }
  s.clips.push(clip);
  s.at = Date.now();
  // Throttle the counter update so 100 incoming clips don't trip Telegram's edit limits.
  if (s.statusId && ctx.chat && Date.now() - s.lastEdit > 2500) {
    s.lastEdit = Date.now();
    const total = s.clips.reduce((n, c) => n + (c.seconds || 0), 0);
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        s.statusId,
        undefined,
        `🎙 جُمِع: <b>${s.clips.length}</b> مقطع${total ? ` · ~${total}s` : ''}\nاكتب /buildzip لمّا تخلّص.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  }
}

async function build(ctx: BotContext, s: Session): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  if (!s.clips.length) {
    await ctx.reply('⚠️ ما جمّعت أي مقطع بعد. أرسل رسائل صوتية أولاً.').catch(() => undefined);
    return;
  }
  const n = s.clips.length;
  sessions.delete(ctx.from.id);
  const status = await ctx.reply(`📦 جاري تحميل وضغط ${n} مقطع… ⏳`).catch(() => undefined);
  const statusId = (status as { message_id?: number } | undefined)?.message_id;
  await ctx.sendChatAction('upload_document').catch(() => undefined);
  const edit = (t: string): Promise<unknown> =>
    statusId ? ctx.telegram.editMessageText(ctx.chat!.id, statusId, undefined, t).catch(() => undefined) : ctx.reply(t).catch(() => undefined);

  const dir = await mkdtemp(join(tmpdir(), 'vds-'));
  const folder = 'voices';
  const voicesDir = join(dir, folder);
  const cleanup = (): Promise<unknown> => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  try {
    await mkdir(voicesDir, { recursive: true });
    const manifest: string[] = ['index\tfile\tseconds'];
    let total = 0;
    let saved = 0;
    let truncated = false;

    for (let i = 0; i < s.clips.length; i++) {
      const clip = s.clips[i];
      const name = `${String(saved + 1).padStart(3, '0')}.${safeExt(clip.ext)}`;
      const dest = join(voicesDir, name);
      const link = await ctx.telegram.getFileLink(clip.fileId).catch(() => null);
      if (!link) continue;
      if (!(await downloadTo(link.toString(), dest))) continue;
      const sz = (await stat(dest).catch(() => ({ size: 0 }) as { size: number })).size;
      if (sz <= 0 || sz > MAX_FILE_BYTES) {
        await rm(dest, { force: true }).catch(() => undefined);
        continue;
      }
      if (total + sz > MAX_ARCHIVE_BYTES) {
        await rm(dest, { force: true }).catch(() => undefined);
        truncated = true;
        break;
      }
      total += sz;
      saved++;
      manifest.push(`${saved}\t${name}\t${clip.seconds || ''}`);
      if (saved % 15 === 0) await edit(`📦 تحميل… ${saved}/${n}`);
    }

    if (!saved) return void (await edit('⚠️ تعذّر تحميل أي مقطع. حاول من جديد.'));
    await writeFile(join(voicesDir, 'manifest.txt'), manifest.join('\n') + '\n', 'utf8');

    await edit('🗜 جاري الضغط…');
    const archive = await makeArchive(dir, folder);
    if (!archive) return void (await edit('⚠️ تعذّر إنشاء الملف المضغوط.'));
    const asz = (await stat(archive)).size;
    if (asz <= 0) return void (await edit('⚠️ الملف المضغوط فارغ.'));

    const base = archive.endsWith('.tar.gz') ? 'voices_dataset.tar.gz' : 'voices_dataset.zip';
    await ctx
      .replyWithDocument(Input.fromLocalFile(archive, base), {
        caption:
          `📦 داتاسيت الفويسات\n` +
          `✅ ${saved} مقطع · ${(asz / 1024 / 1024).toFixed(1)}MB\n` +
          (truncated ? '⚠️ وقفت عند حد 45MB — الباقي ما انضاف.\n' : '') +
          'مرفق manifest.txt بفهرس الملفات.',
      })
      .catch(() => undefined);
    if (statusId) await ctx.telegram.deleteMessage(ctx.chat.id, statusId).catch(() => undefined);
  } catch (err) {
    log.error({ err }, 'voicedataset build failed');
    await edit('⚠️ صار خطأ أثناء التجهيز.');
  } finally {
    await cleanup();
  }
}

async function buildMerge(ctx: BotContext, s: Session): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  if (!s.clips.length) {
    await ctx.reply('⚠️ ما جمّعت أي مقطع بعد. أرسل رسائل صوتية أولاً.').catch(() => undefined);
    return;
  }
  const n = s.clips.length;
  sessions.delete(ctx.from.id);
  const status = await ctx.reply(`🎚 جاري دمج ${n} مقطع بتسجيل واحد… ⏳`).catch(() => undefined);
  const statusId = (status as { message_id?: number } | undefined)?.message_id;
  await ctx.sendChatAction('upload_voice').catch(() => undefined);
  const edit = (t: string): Promise<unknown> =>
    statusId ? ctx.telegram.editMessageText(ctx.chat!.id, statusId, undefined, t).catch(() => undefined) : ctx.reply(t).catch(() => undefined);

  const dir = await mkdtemp(join(tmpdir(), 'vmrg-'));
  const cleanup = (): Promise<unknown> => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  try {
    const parts: string[] = [];
    for (let i = 0; i < s.clips.length; i++) {
      const clip = s.clips[i];
      const raw = join(dir, `raw_${i}`);
      const part = join(dir, `part_${String(parts.length + 1).padStart(3, '0')}.ogg`);
      const link = await ctx.telegram.getFileLink(clip.fileId).catch(() => null);
      if (!link) continue;
      if (!(await downloadTo(link.toString(), raw))) continue;
      if ((await stat(raw).catch(() => ({ size: 0 }) as { size: number })).size > MAX_FILE_BYTES) {
        await rm(raw, { force: true }).catch(() => undefined);
        continue;
      }
      // Normalize to a uniform OGG so clips of different codecs/rates concat cleanly.
      if (await normalizeToOgg(raw, part)) parts.push(part);
      await rm(raw, { force: true }).catch(() => undefined);
      if (parts.length % 15 === 0) await edit(`🎚 معالجة… ${parts.length}/${n}`);
    }
    if (!parts.length) return void (await edit('⚠️ تعذّر معالجة أي مقطع.'));

    const listPath = join(dir, 'list.txt');
    await writeFile(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    await edit('🎚 جاري الدمج…');
    const out = join(dir, 'merged.ogg');
    if (!(await concatToOgg(listPath, out))) return void (await edit('⚠️ تعذّر دمج التسجيلات.'));
    const sz = (await stat(out).catch(() => ({ size: 0 }) as { size: number })).size;
    if (sz <= 0) return void (await edit('⚠️ الناتج فارغ.'));
    if (sz > MAX_MERGE_BYTES)
      return void (await edit(`⚠️ التسجيل المدموج كبير جداً (${(sz / 1024 / 1024).toFixed(0)}MB > 48MB). جرّب مقاطع أقل.`));

    await ctx
      .replyWithVoice(Input.fromLocalFile(out, 'merged.ogg'), {
        caption: `🎙 تسجيل واحد مدموج من ${parts.length} مقطع · ${(sz / 1024 / 1024).toFixed(1)}MB`,
      })
      .catch(() => undefined);
    if (statusId) await ctx.telegram.deleteMessage(ctx.chat.id, statusId).catch(() => undefined);
  } catch (err) {
    log.error({ err }, 'voicedataset merge failed');
    await edit('⚠️ صار خطأ أثناء الدمج.');
  } finally {
    await cleanup();
  }
}

/**
 * 🎙 Collect many voice messages into a tidy ZIP. Send /collectvoices (private),
 * forward/record as many voices as you like, then /buildzip — the bot numbers
 * them, adds a manifest, and sends back a single archive.
 */
export const voiceDatasetPlugin: Plugin = {
  name: 'voicedataset',
  description: 'Collect many voice messages and return them as one ZIP dataset',
  commands: [
    { command: 'collectvoices', description: '🎙 اجمع فويسات (بالخاص) ثم ضغط أو دمج' },
    { command: 'buildzip', description: '📦 جهّز ملف الفويسات المضغوط' },
    { command: 'buildmerge', description: '🎚 ادمج الفويسات بتسجيل واحد' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('collectvoices', (ctx) => startSession(ctx));
    bot.hears(START_RE, async (ctx, next) => {
      if (ctx.chat?.type === 'private') return void startSession(ctx);
      return next();
    });

    const sessionOf = (ctx: BotContext): Session | undefined => {
      if (ctx.chat?.type !== 'private' || !ctx.from) return undefined;
      const s = freshSession(sessions.get(ctx.from.id));
      if (!s) sessions.delete(ctx.from.id);
      return s;
    };

    // Collect incoming audio while a session is active; otherwise pass through.
    const collect = async (ctx: BotContext, next: () => Promise<void>): Promise<void> => {
      const s = sessionOf(ctx);
      if (!s) return next();
      const clip = clipFromMessage(ctx.message);
      if (!clip) return next();
      await addClip(ctx, s, clip);
    };
    bot.on(message('voice'), collect);
    bot.on(message('audio'), collect);
    bot.on(message('document'), async (ctx, next) => {
      const s = sessionOf(ctx);
      if (!s) return next();
      const clip = clipFromMessage(ctx.message);
      if (!clip) return next(); // not audio → let other plugins handle it
      await addClip(ctx, s, clip);
    });

    // Finish / cancel keywords, only while a session is active.
    bot.on(message('text'), async (ctx, next) => {
      const s = sessionOf(ctx);
      if (!s) return next();
      const text = (ctx.message as { text: string }).text.trim();
      if (CANCEL_RE.test(text)) {
        sessions.delete(ctx.from!.id);
        return void ctx.reply('✖️ تم الإلغاء.').catch(() => undefined);
      }
      // Detached: downloading + archiving/merging 100 clips can exceed the 30s handler timeout.
      if (MERGE_RE.test(text)) {
        void buildMerge(ctx, s).catch((err) => log.error({ err }, 'voicedataset merge (detached) failed'));
        return;
      }
      if (DONE_RE.test(text)) {
        void build(ctx, s).catch((err) => log.error({ err }, 'voicedataset build (detached) failed'));
        return;
      }
      return next();
    });
  },
};
