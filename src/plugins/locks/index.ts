import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:locks');

// Each lock: the ChatSettings column + a display name + the Arabic words that
// name that content type. Locking one deletes that message type from non-staff.
type LockKey =
  | 'lockPhoto'
  | 'lockVideo'
  | 'lockVoice'
  | 'lockAudio'
  | 'lockSticker'
  | 'lockGif'
  | 'lockDocument'
  | 'lockContact'
  | 'lockLocation'
  | 'lockPoll'
  | 'lockVideoNote';

interface LockDef {
  key: LockKey;
  name: string;
  words: string[];
}

const LOCKS: LockDef[] = [
  { key: 'lockPhoto', name: 'الصور', words: ['صور', 'الصور', 'صوره', 'الصوره', 'صورة', 'الصورة'] },
  { key: 'lockVideo', name: 'الفيديو', words: ['فيديو', 'الفيديو', 'فيديوهات', 'الفيديوهات', 'مقاطع'] },
  { key: 'lockVoice', name: 'الفويس', words: ['فويس', 'الفويس', 'بصمه', 'البصمه', 'بصمة', 'بصمات', 'تسجيل', 'التسجيل'] },
  { key: 'lockAudio', name: 'الملفات الصوتية', words: ['مقطع صوتي', 'الصوتيات', 'صوتيات'] },
  { key: 'lockSticker', name: 'الملصقات', words: ['ملصق', 'ملصقات', 'الملصقات', 'ستيكر', 'استكر', 'استكرات', 'الاستكرات'] },
  { key: 'lockGif', name: 'المتحرك', words: ['متحرك', 'المتحرك', 'متحركه', 'المتحركه', 'قيف', 'جيف', 'gif'] },
  { key: 'lockDocument', name: 'الملفات', words: ['ملف', 'ملفات', 'الملفات', 'مستند', 'مستندات', 'المستندات'] },
  { key: 'lockContact', name: 'جهات الاتصال', words: ['جهه', 'جهات', 'الجهات', 'جهةاتصال', 'ارقام', 'الارقام'] },
  { key: 'lockLocation', name: 'الموقع', words: ['موقع', 'الموقع', 'لوكيشن', 'المواقع'] },
  { key: 'lockPoll', name: 'الاستفتاءات', words: ['استفتاء', 'الاستفتاء', 'استطلاع', 'تصويت', 'التصويت'] },
  { key: 'lockVideoNote', name: 'الفيديو المدور', words: ['مدور', 'المدور', 'فيديومدور', 'كام'] },
];

const WORD_TO_LOCK = new Map<string, LockDef>();
for (const l of LOCKS) for (const w of l.words) WORD_TO_LOCK.set(w, l);

// Verbs: قفل/تعطيل/منع → block; فتح/تفعيل/سماح → allow. Note the polarity is the
// opposite of the protection toggles (there تفعيل turns a *protection* on): here
// «تفعيل الصور» means allow images, «تعطيل الصور» means block them.
const LOCK_VERBS = new Set(['قفل', 'اقفل', 'أقفل', 'قفله', 'تعطيل', 'عطل', 'عطّل', 'منع', 'امنع', 'حظر', 'اخفاء', 'اخف']);
const UNLOCK_VERBS = new Set(['فتح', 'افتح', 'تفعيل', 'فعل', 'فعّل', 'سماح', 'اسمح', 'رفع', 'الغاء', 'إلغاء', 'اظهار', 'ازالة']);
const VERB_RE = new RegExp(`^(${[...LOCK_VERBS, ...UNLOCK_VERBS].join('|')})\\s+(\\S+)$`);

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Which lock (if any) applies to this message's content. Order matters:
 *  animation/video_note carry a `document`/`video` field too, so test them first. */
function lockedKeyOf(msg: Record<string, unknown>): LockKey | null {
  if (msg.photo) return 'lockPhoto';
  if (msg.animation) return 'lockGif';
  if (msg.video_note) return 'lockVideoNote';
  if (msg.video) return 'lockVideo';
  if (msg.voice) return 'lockVoice';
  if (msg.audio) return 'lockAudio';
  if (msg.sticker) return 'lockSticker';
  if (msg.document) return 'lockDocument';
  if (msg.contact) return 'lockContact';
  if (msg.location || msg.venue) return 'lockLocation';
  if (msg.poll) return 'lockPoll';
  return null;
}

export const locksPlugin: Plugin = {
  name: 'locks',
  description: 'Content locks: block photos/voice/stickers/… from non-staff',
  commands: [{ command: 'locks', description: '🔒 قائمة الأقفال (تعطيل الصور/الفويس…)' }],

  register(bot: Telegraf<BotContext>) {
    // --- List current locks ---
    const showLocks = async (ctx: BotContext): Promise<void> => {
      if (!isGroup(ctx)) return;
      const s = ctx.state.settings as unknown as Record<LockKey, boolean> | undefined;
      const lines = LOCKS.map((l) => `${s?.[l.key] ? '🔒' : '🔓'} ${l.name}`);
      await ctx
        .reply(
          ['🔐 <b>الأقفال</b>', ...lines, '', 'للقفل: «تعطيل الصور» — للفتح: «تفعيل الصور»'].join('\n'),
        )
        .catch(() => undefined);
    };
    bot.command('locks', (ctx) => showLocks(ctx));

    // --- «تعطيل/قفل/منع <نوع>» و «تفعيل/فتح <نوع>» (staff only) ---
    bot.hears(VERB_RE, async (ctx, next) => {
      if (!isGroup(ctx)) return next();
      const verb = ctx.match[1];
      const word = ctx.match[2];
      // «الأقفال» / «الاقفال» → list.
      if (word === 'الاقفال' || word === 'الأقفال') return next();
      const def = WORD_TO_LOCK.get(word);
      if (!def) return next(); // known verb but not a lock word → let others handle it
      if (!ctx.state.isStaff) return next(); // silently ignore for non-staff
      const lock = LOCK_VERBS.has(verb);
      await prisma.chatSettings
        .update({ where: { chatId: BigInt(ctx.chat!.id) }, data: { [def.key]: lock } })
        .catch(() => undefined);
      if (ctx.state.settings) (ctx.state.settings as unknown as Record<string, boolean>)[def.key] = lock;
      await ctx
        .reply(lock ? `🔒 تم <b>قفل ${def.name}</b> — ما حدا غير المشرفين يقدر يرسلها.` : `🔓 تم <b>فتح ${def.name}</b>.`)
        .catch(() => undefined);
    });

    // «الأقفال» بمفردها → عرض القائمة.
    bot.hears(/^(الاقفال|الأقفال|الاقفال؟)$/, (ctx) => showLocks(ctx));

    // --- Enforcement: delete locked content from non-staff ---
    bot.on('message', async (ctx, next) => {
      if (!isGroup(ctx) || ctx.state.isStaff) return next();
      const key = lockedKeyOf(ctx.message as unknown as Record<string, unknown>);
      if (!key) return next();
      const s = ctx.state.settings as unknown as Record<LockKey, boolean> | undefined;
      if (!s?.[key]) return next();
      // Locked → delete and consume (don't let other handlers act on it).
      await ctx.deleteMessage().catch((err) => log.debug({ err }, 'lock delete failed (bot not admin?)'));
      return; // consumed
    });
  },
};
