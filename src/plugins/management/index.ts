import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { env } from '../../config/env';
import { requireRole, hasRole } from '../../utils/permissions';
import { displayName } from '../../utils/format';
import { createLogger } from '../../core/logger';
import { wakeStreamerOnce } from '../music';

const log = createLogger('plugin:management');

/** Tracks which chats we've currently locked via night mode (transition-only calls). */
const nightLocked = new Set<string>();

function currentHour(tz = env.DEFAULT_TIMEZONE): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date()),
  );
}

/** Is `hour` within the night window [start, end) (handles overnight wrap)? */
function inNightWindow(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Per-chat cooldown for the mention-all call, shared across all admins.
const ALL_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes
const allLastUsed = new Map<number, number>();

// A live mention-all run per chat, so «وقف المنشن» can cancel it mid-way. The
// batch loop checks token.cancelled between sends (each await yields, letting the
// stop command run). Present in the map ⇒ a run is in progress.
const activeMention = new Map<number, { cancelled: boolean }>();

const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

/** Fetch a group's FULL member list from the streamer. `path` is /members_bot
 *  (the bot itself, via MTProto — works in every group the bot admins) or
 *  /members (the assistant account). Returns null if unavailable. */
async function fetchMembers(path: '/members_bot' | '/members', chatId: number): Promise<{ id: number; name: string }[] | null> {
  if (!STREAMER_URL) return null;
  try {
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(45_000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; members?: { id: number; name: string }[] } | null;
    return data?.ok && Array.isArray(data.members) && data.members.length ? data.members : null;
  } catch {
    return null;
  }
}

/**
 * Full member list. Prefer the BOT itself (/members_bot) — it works in EVERY
 * group the bot administers, so no assistant account needs to be added. Falls
 * back to the assistant account, and wakes the sleeping streamer once (Render
 * free tier) before giving up. Returns null if neither path yields members.
 */
async function fetchAllGroupMembers(
  ctx: BotContext,
  chatId: number,
): Promise<{ list: { id: number; name: string }[]; source: 'bot' | 'assistant' } | null> {
  let list = await fetchMembers('/members_bot', chatId);
  if (list) return { list, source: 'bot' };
  if (!STREAMER_URL) return null;
  // Streamer is likely cold — tell the user, wake it, and retry (bot, then assistant).
  const notice = await ctx.reply('⏳ جاري إحضار كل الأعضاء… (بياخد لـ دقيقة أول مرة)').catch(() => null);
  await wakeStreamerOnce().catch(() => false);
  let source: 'bot' | 'assistant' = 'bot';
  for (let i = 0; i < 2 && !list; i++) {
    list = await fetchMembers('/members_bot', chatId);
    if (!list) await sleep(2500);
  }
  if (!list) {
    list = await fetchMembers('/members', chatId);
    source = 'assistant';
  }
  if (notice) await ctx.telegram.deleteMessage(chatId, notice.message_id).catch(() => undefined);
  return list ? { list, source } : null;
}

/**
 * Mention EVERY registered member (those the bot has seen) in batches. A bot
 * can't list a group's full membership via the Bot API, so this reaches everyone
 * the bot has recorded. Rate-limited with a delay so Telegram doesn't drop the
 * later batches (which is why it used to stop early), and gated by a 20-minute
 * per-chat cooldown shared across admins.
 */
async function mentionAll(ctx: BotContext, note: string): Promise<void> {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  const chatId = ctx.chat.id;

  const last = allLastUsed.get(chatId);
  if (last && Date.now() - last < ALL_COOLDOWN_MS) {
    const leftMin = Math.ceil((ALL_COOLDOWN_MS - (Date.now() - last)) / 60000);
    return void ctx.reply(`⏳ تم النداء مؤخراً. ضل <b>${leftMin}</b> دقيقة قبل نداء جديد.`);
  }

  // Prefer the FULL member list (the bot itself via MTProto, then the assistant);
  // fall back to members the bot has recorded from activity only if both fail.
  const got = await fetchAllGroupMembers(ctx, chatId);
  const full = !!got;
  let people: { id: bigint | number; name: string }[];
  if (got) {
    people = got.list.map((m) => ({ id: m.id, name: m.name }));
  } else {
    const members = await prisma.member.findMany({
      where: { chatId: BigInt(chatId) },
      orderBy: { lastSeenAt: 'desc' },
      take: 1000,
    });
    people = members.map((m) => ({ id: m.userId, name: m.firstName ?? 'عضو' }));
  }
  if (!people.length) return void ctx.reply('لا يوجد أعضاء لمناداتهم بعد.');

  allLastUsed.set(chatId, Date.now()); // start the cooldown now

  // A tg://user?id= link is a real mention entity — it pings the member and
  // works even when they have no @username. Names are HTML-escaped.
  const mentions = people.map((m) => `<a href="tg://user?id=${m.id}">${escapeHtml(m.name)}</a>`);
  const header = note
    ? `📢 ${escapeHtml(note)}\n\n`
    : full
      ? `📢 نداء للجميع (${mentions.length}):\n\n`
      : `📢 نداء (${mentions.length} عضو مسجّل):\n\n`;
  // Register this run so «وقف المنشن» can stop it. 8 mentions per message; pause
  // between batches so Telegram doesn't rate-limit and silently drop the later ones.
  const token = { cancelled: false };
  activeMention.set(chatId, token);
  try {
    for (let i = 0; i < mentions.length; i += 8) {
      if (token.cancelled) {
        await ctx.reply('🛑 تم إيقاف النداء.').catch(() => undefined);
        return;
      }
      const chunk = mentions.slice(i, i + 8).join(' ');
      await ctx.reply((i === 0 ? header : '') + chunk, { parse_mode: 'HTML' }).catch(() => undefined);
      if (i + 8 < mentions.length) await sleep(700);
    }
  } finally {
    activeMention.delete(chatId);
  }

  // When we couldn't get the FULL list, tell the admin why the count looks small.
  if (!full) {
    await ctx
      .reply(
        'ℹ️ تعذّر جلب كل الأعضاء الآن (خدمة العضويات موقّفة مؤقتاً) — منشنت المسجّلين فقط. جرّب بعد شوي.',
      )
      .catch(() => undefined);
  }
}

export const managementPlugin: Plugin = {
  name: 'management',
  description: 'Night mode, service-message cleanup, mention-all, admins list',
  commands: [
    { command: 'nightmode', description: '🌙 وضع الليل: /nightmode on 23 6', staffOnly: true },
    { command: 'all', description: '📢 منشن كل الأعضاء', staffOnly: true },
    { command: 'stopall', description: '🛑 إيقاف النداء الجاري', staffOnly: true },
    { command: 'admins', description: '👮 قائمة الأدمن' },
    { command: 'checkup', description: '🩺 فحص صلاحيات البوت وإعداداته', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- Night mode config ---
    bot.command('nightmode', requireRole('manager'), async (ctx) => {
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const state = parts[0];
      if (state !== 'on' && state !== 'off') {
        await ctx.reply('🌙 استخدم: /nightmode on 23 6   (تفعيل من 11م حتى 6ص)\nأو: /nightmode off');
        return;
      }
      const start = Math.min(Math.max(parseInt(parts[1] ?? '0', 10) || 0, 0), 23);
      const end = Math.min(Math.max(parseInt(parts[2] ?? '6', 10) || 6, 0), 23);
      await prisma.chatSettings.update({
        where: { chatId: BigInt(ctx.chat.id) },
        data: { nightModeEnabled: state === 'on', nightStartHour: start, nightEndHour: end },
      });
      await ctx.reply(
        state === 'on'
          ? `🌙 تم تفعيل وضع الليل: القفل من الساعة ${start}:00 حتى ${end}:00.`
          : '☀️ تم إيقاف وضع الليل.',
      );
    });

    // --- Mention all registered members (in batches) ---
    bot.command('all', requireRole('admin'), async (ctx) => {
      const note = ctx.message.text.split(' ').slice(1).join(' ').trim();
      await mentionAll(ctx, note);
    });

    // Also trigger on a bare "@all" / "@everyone" / "@الكل" (staff only).
    bot.on(message('text'), async (ctx, next) => {
      const text = ctx.message.text.trim();
      const m = /^@(all|everyone|الكل|الجميع)\b\s*/i.exec(text);
      if (!m) return next();
      if (!ctx.state.isStaff) return next(); // silently ignore for non-staff
      await mentionAll(ctx, text.slice(m[0].length).trim());
      return; // consumed
    });

    // --- Stop a running mention-all ---
    const stopMention = async (ctx: BotContext): Promise<void> => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const token = activeMention.get(ctx.chat.id);
      if (token) {
        token.cancelled = true;
        await ctx.reply('🛑 جاري إيقاف النداء…').catch(() => undefined);
      } else {
        await ctx.reply('ℹ️ ما في نداء شغّال حالياً.').catch(() => undefined);
      }
    };

    bot.command('stopall', requireRole('admin'), async (ctx) => stopMention(ctx));

    // Bare Arabic triggers: «وقف المنشن» / «ايقاف المنشن» / «وقف النداء» … (staff only).
    bot.on(message('text'), async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (!/^(وقف|إيقاف|ايقاف|الغاء|إلغاء)\s*(ال)?(منشن|نداء|الكل)/.test(text)) return next();
      if (!ctx.state.isStaff) return next();
      await stopMention(ctx);
      return; // consumed
    });

    // --- Why does @all tag only N? (founder diagnostic) ---
    bot.command('alldiag', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      if (!hasRole(ctx.state.role ?? 'member', 'founder')) return;
      const dbCount = await prisma.member.count({ where: { chatId: BigInt(ctx.chat.id) } }).catch(() => -1);
      let botLine: string;
      let assistant: string;
      if (!STREAMER_URL) {
        botLine = '❌ غير مهيّأ (STREAMER_URL فاضي)';
        assistant = '❌ غير مهيّأ';
      } else {
        await wakeStreamerOnce().catch(() => false); // wake before testing so a sleeping service isn't misreported
        let b = await fetchMembers('/members_bot', ctx.chat.id);
        if (!b) {
          await sleep(2500);
          b = await fetchMembers('/members_bot', ctx.chat.id);
        }
        botLine = b ? `✅ يعمل — رجّع <b>${b.length}</b> عضو` : '❌ فشل (البوت مش أدمن، أو BOT_TOKEN ناقص، أو الخدمة موقّفة)';
        const r = await fetchMembers('/members', ctx.chat.id);
        assistant = r ? `✅ يعمل — رجّع <b>${r.length}</b> عضو` : '➖ غير متاح (اختياري الآن)';
      }
      const lines = [
        '🩺 <b>تشخيص «الكل»</b>',
        `• أعضاء مسجّلين بالبوت: <b>${dbCount}</b>`,
        `• البوت مباشرة (MTProto): ${botLine}`,
        `• حساب المساعد (احتياطي): ${assistant}`,
        '',
        'ℹ️ «الكل» بيعتمد على البوت مباشرة — لازم يكون البوت أدمن بالجروب فقط، بدون أي حساب مساعد.',
      ];
      await ctx.reply(lines.join('\n')).catch(() => undefined);
    });

    // --- Experiment: can the BOT itself enumerate members via MTProto? ---
    // Founder-only. Wakes the streamer, then asks it to run channels.getParticipants
    // with the BOT token (not the assistant) and reports the exact result/error.
    bot.command('mtprototest', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      if (!hasRole(ctx.state.role ?? 'member', 'founder')) return;
      if (!STREAMER_URL) return void ctx.reply('❌ STREAMER_URL غير مهيّأ.');
      const arg = ctx.message.text.split(/\s+/).slice(1)[0];
      const chatId = arg ? Number(arg) : ctx.chat.id;
      const notice = await ctx.reply('⏳ جاري إيقاظ الخدمة وتجربة جلب الأعضاء بتوكن البوت…').catch(() => null);
      await wakeStreamerOnce().catch(() => false);
      let out = '❌ فشل الاتصال بالخدمة.';
      try {
        const res = await fetch(`${STREAMER_URL}/members_bot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
          body: JSON.stringify({ chat_id: chatId }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; count?: number; capped?: boolean; members?: { id: number; name: string }[]; error?: string }
          | null;
        if (data?.ok) {
          const sample = (data.members ?? []).slice(0, 20).map((s) => `• ${escapeHtml(s.name)} (<code>${s.id}</code>)`).join('\n');
          out = [
            '✅ <b>SUCCESS</b> — البوت قدر يجيب الأعضاء عبر MTProto!',
            `• العدد: <b>${data.count}</b>${data.capped ? ' (متوقّف عند الحد ٥٠٠٠)' : ''}`,
            sample ? `\nعيّنة:\n${sample}` : '',
          ].join('\n');
        } else if (data?.error === 'no_bot_token') {
          out = '⚠️ لازم تضيف <code>BOT_TOKEN</code> لمتغيّرات خدمة الكول أول (شوف التعليمات).';
        } else {
          out = `❌ <b>FAILED</b>\n<code>${escapeHtml(data?.error ?? 'unknown')}</code>`;
        }
      } catch (err) {
        out = `❌ خطأ بالطلب: <code>${escapeHtml(String(err).slice(0, 150))}</code>`;
      }
      if (notice) await ctx.telegram.deleteMessage(ctx.chat.id, notice.message_id).catch(() => undefined);
      await ctx.reply(out).catch(() => undefined);
    });

    // --- Admins list ---
    bot.command('admins', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        const list = admins
          .filter((a) => !a.user.is_bot)
          .map((a) => `• ${displayName(a.user)}${a.status === 'creator' ? ' 👑' : ''}`)
          .join('\n');
        await ctx.reply(`👮 المشرفون:\n${list}`);
      } catch {
        await ctx.reply('❌ تعذّر جلب قائمة المشرفين.');
      }
    });

    // --- Diagnostic checkup: bot rights + feature toggles ---
    bot.command('checkup', requireRole('admin'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const yn = (v: boolean) => (v ? '✔️' : '❌');
      const s = ctx.state.settings;
      let admin = false;
      let canDelete = false;
      let canRestrict = false;
      let canPin = false;
      try {
        const me = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo!.id);
        admin = me.status === 'administrator' || me.status === 'creator';
        const a = me as { can_delete_messages?: boolean; can_restrict_members?: boolean; can_pin_messages?: boolean };
        canDelete = admin && !!a.can_delete_messages;
        canRestrict = admin && !!a.can_restrict_members;
        canPin = admin && !!a.can_pin_messages;
      } catch {
        /* couldn't read own membership */
      }

      const RULE = '➖➖➖➖➖➖➖➖';
      const lines = [
        '🩺 <b>فحص البوت</b>',
        RULE,
        '',
        '👮 <b>الصلاحيات</b>',
        `${yn(admin)} مشرف بالجروب`,
        `${yn(canDelete)} حذف الرسائل`,
        `${yn(canRestrict)} حظر / تقييد الأعضاء`,
        `${yn(canPin)} تثبيت الرسائل`,
        '',
        '🛡 <b>الحمايات</b>',
        `${yn(!!s?.antispamEnabled)} مكافحة السبام`,
        `${yn(!!s?.floodEnabled)} منع التكرار`,
        `${yn(!!(s as { badwordsEnabled?: boolean })?.badwordsEnabled)} منع السب`,
        `${yn(!!s?.antiLinkEnabled)} منع الروابط`,
        `${yn(!!s?.antiRaidEnabled)} مكافحة الغارات`,
        `${yn(!!s?.filtersEnabled)} فلتر الكلمات`,
      ];

      // No parse_mode: the outgoing interceptor renders the <b> tags as entities.
      await ctx.reply(lines.join('\n')).catch(() => undefined);
    });

    // --- Auto-delete service messages (join/leave) ---
    const cleanup = async (ctx: BotContext, next: () => Promise<void>) => {
      if (ctx.state.settings?.cleanServiceEnabled) {
        await ctx.deleteMessage().catch(() => undefined);
      }
      return next(); // let welcome/farewell still run
    };
    bot.on(message('new_chat_members'), cleanup);
    bot.on(message('left_chat_member'), cleanup);

    // --- Night-mode ticker: lock/unlock on the minute ---
    const interval = setInterval(() => {
      void tickNightMode(bot);
    }, 60_000);
    interval.unref?.();
  },
};

async function tickNightMode(bot: Telegraf<BotContext>): Promise<void> {
  try {
    const chats = await prisma.chatSettings.findMany({ where: { nightModeEnabled: true } });
    const hour = currentHour();
    for (const c of chats) {
      const key = String(c.chatId);
      const shouldLock = inNightWindow(hour, c.nightStartHour, c.nightEndHour);
      const isLocked = nightLocked.has(key);
      if (shouldLock && !isLocked) {
        await bot.telegram
          .setChatPermissions(Number(c.chatId), { can_send_messages: false })
          .then(() => {
            nightLocked.add(key);
            return bot.telegram.sendMessage(Number(c.chatId), '🌙 وضع الليل: تم إغلاق الكتابة حتى الصباح.');
          })
          .catch(() => undefined);
      } else if (!shouldLock && isLocked) {
        await bot.telegram
          .setChatPermissions(Number(c.chatId), {
            can_send_messages: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
          })
          .then(() => {
            nightLocked.delete(key);
            return bot.telegram.sendMessage(Number(c.chatId), '☀️ صباح الخير! تم فتح الكتابة.');
          })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    log.warn({ err }, 'night mode tick failed');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
