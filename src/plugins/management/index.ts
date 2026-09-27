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
import { getGlobal, setGlobal } from '../../services/global.service';
import { fetchChatMembersViaBot, mtprotoConfigured, getLastMtprotoError } from '../../services/mtproto/members';

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
async function fetchMembers(
  path: '/members_bot' | '/members',
  chatId: number,
  timeoutMs = 45_000,
): Promise<{ id: number; name: string }[] | null> {
  if (!STREAMER_URL) return null;
  try {
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; members?: { id: number; name: string }[] } | null;
    return data?.ok && Array.isArray(data.members) && data.members.length ? data.members : null;
  } catch {
    return null;
  }
}

type Member = { id: number; name: string };

// The full roster is cached per chat so mention-all responds INSTANTLY even when
// the streamer (which hosts the bot-MTProto member lookup) is asleep on Render's
// free tier. The streamer is only needed to (re)build the cache, in the
// background — never on the hot path once a roster exists.
const rosterKey = (chatId: number): string => `roster:${chatId}`;

async function loadRoster(chatId: number): Promise<Member[] | null> {
  const raw = await getGlobal(rosterKey(chatId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { members?: Member[] };
    return Array.isArray(p.members) && p.members.length ? p.members : null;
  } catch {
    return null;
  }
}

async function saveRoster(chatId: number, members: Member[]): Promise<void> {
  if (!members.length) return;
  await setGlobal(rosterKey(chatId), JSON.stringify({ at: Date.now(), members: members.slice(0, 5000) })).catch(
    () => undefined,
  );
}

/** Wake the streamer (up to ~3min) and rebuild the roster — no user reply. Used
 *  for a first-time seed and for background refreshes. */
async function wakeAndRefreshRoster(chatId: number): Promise<Member[] | null> {
  await wakeStreamerOnce().catch(() => false);
  let list = await fetchMembers('/members_bot', chatId);
  if (!list) list = await fetchMembers('/members', chatId);
  if (list) await saveRoster(chatId, list);
  return list;
}

/**
 * Acquire the full member list for mention-all without blocking on a sleeping
 * streamer:
 *  1) a quick /members_bot try (streamer already awake) → use + refresh cache;
 *  2) else the cached roster (instant) + a background wake to refresh it;
 *  3) else (never fetched) a one-time blocking wake to seed it.
 * Returns null only when we truly have nothing (→ caller falls back to the DB).
 */
async function fetchAllGroupMembers(ctx: BotContext, chatId: number): Promise<Member[] | null> {
  // 1) The BOT itself via MTProto — always awake, no streamer, no "first time"
  //    wait, and independent of who has talked. This is the main path.
  if (mtprotoConfigured()) {
    const viaBot = await fetchChatMembersViaBot(chatId);
    if (viaBot) {
      await saveRoster(chatId, viaBot);
      return viaBot;
    }
  }
  // 2) Cached roster — instant, covers a transient MTProto hiccup.
  const cached = await loadRoster(chatId);
  if (cached) return cached;
  // 3) Legacy fallback: the streamer's bot-MTProto (may be asleep on free tier).
  if (STREAMER_URL) {
    const quick = await fetchMembers('/members_bot', chatId, 12_000);
    if (quick) {
      await saveRoster(chatId, quick);
      return quick;
    }
    const notice = await ctx.reply('⏳ جاري إحضار كل الأعضاء…').catch(() => null);
    const seeded = await wakeAndRefreshRoster(chatId);
    if (notice) await ctx.telegram.deleteMessage(chatId, notice.message_id).catch(() => undefined);
    return seeded;
  }
  return null;
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

  // Prefer the FULL member list (cached roster, refreshed via the bot's MTProto
  // lookup); fall back to members the bot has recorded from activity only if we
  // have never managed to fetch a roster for this chat.
  const got = await fetchAllGroupMembers(ctx, chatId);
  const full = !!got;
  let people: { id: bigint | number; name: string }[];
  if (got) {
    people = got.map((m) => ({ id: m.id, name: m.name }));
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
      // Primary path: the bot itself via MTProto (gramjs) — always awake.
      let inBot: string;
      if (!mtprotoConfigured()) {
        inBot = '⚠️ غير مهيّأ — ضيف API_ID و API_HASH لمتغيّرات البوت';
      } else {
        const m = await fetchChatMembersViaBot(ctx.chat.id);
        inBot = m ? `✅ يعمل — رجّع <b>${m.length}</b> عضو` : `❌ فشل: <code>${escapeHtml(getLastMtprotoError())}</code>`;
      }
      const cached = await loadRoster(ctx.chat.id);
      const lines = [
        '🩺 <b>تشخيص «الكل»</b>',
        `• البوت مباشرة (MTProto): ${inBot}`,
        `• قائمة محفوظة (cache): ${cached ? `✅ <b>${cached.length}</b> عضو` : '➖ لا يوجد بعد'}`,
        `• أعضاء مسجّلين (احتياطي أخير): <b>${dbCount}</b>`,
        '',
        'ℹ️ «الكل» صار يعتمد على البوت مباشرة (بدون خدمة المول). يكفي البوت أدمن بالجروب.',
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

    // --- Check the (embedded) voice streamer: alive? assistant connected? UDP? ---
    // Founder-only. UDP is what decides whether voice/WebRTC can work on this host.
    bot.command('streamercheck', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      if (!hasRole(ctx.state.role ?? 'member', 'founder')) return;
      if (!STREAMER_URL) return void ctx.reply('❌ STREAMER_URL غير مهيّأ.');
      const hdr = { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) };
      // Health (is it up + assistant connected?).
      let health = '❌ لا يرد';
      try {
        const r = await fetch(`${STREAMER_URL}/health`, { signal: AbortSignal.timeout(10_000) });
        health = r.ok ? '✅ صاحي (المساعد متصل)' : `⏳ يشتغل (${r.status})`;
      } catch {
        health = '❌ لا يرد (متوقّف)';
      }
      // UDP verdict (can voice/WebRTC work here at all?).
      let udpLine = '❓ غير معروف';
      try {
        const r = await fetch(`${STREAMER_URL}/udptest`, { method: 'POST', headers: hdr, body: '{}', signal: AbortSignal.timeout(20_000) });
        const d = (await r.json().catch(() => null)) as { udp?: boolean } | null;
        udpLine = d?.udp
          ? '✅ يعمل — الصوت ممكن يشتغل هون'
          : '❌ محجوب — Render ما بيسمح UDP، فالمكالمة الصوتية ما رح تشتغل على هالاستضافة';
      } catch {
        udpLine = '❓ تعذّر الفحص';
      }
      await ctx
        .reply(['🎙 <b>فحص الكول</b>', `• الخدمة: ${health}`, `• UDP (الصوت): ${udpLine}`].join('\n'))
        .catch(() => undefined);
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
