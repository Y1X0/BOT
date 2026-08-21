import { Markup, type Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole, resolveRole, hasRole } from '../../utils/permissions';
import { ensureChat, getSettings, setVcCardEmoji } from '../../services/settings.service';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:music');

// The headless streamer service (music-bot/) that owns the assistant account and
// streams into voice chats. Configure these on the bot's environment:
//   STREAMER_URL=http://host:8080   STREAMER_TOKEN=<shared secret>
const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

const NOT_CONFIGURED =
  '🎧 خدمة الكول مش مفعّلة بعد.\nلازم يشتغل سيرفر البث (music-bot) ويُضبط STREAMER_URL على البوت.';

// Rotate the "searching" line so it doesn't get stale.
const SEARCHING = [
  '🎧 لحظة… عم جهّز الأغنية',
  '🔍 عم أنقّب بالمكتبة…',
  '🎵 عم أجيبها من الآخر…',
  '⚡ ثانية وحدة…',
  '🎶 عم أوصلها للكول…',
];
const pickSearching = (): string => SEARCHING[Math.floor(Math.random() * SEARCHING.length)];

interface StreamerResult {
  ok: boolean;
  error?: string;
  queued?: boolean;
  position?: number;
  ended?: boolean;
  already?: boolean;
  seconds?: number;
  title?: string;
  duration?: number;
  thumb?: string;
  uploader?: string;
  active?: { title: string; duration: number } | null;
  upcoming?: { title: string; duration: number }[];
}

async function callStreamer(path: string, body: Record<string, unknown>): Promise<StreamerResult | null> {
  if (!STREAMER_URL) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as StreamerResult;
  } catch (err) {
    log.warn({ err, path }, 'streamer call failed');
    return { ok: false, error: 'unreachable' };
  }
}

function fmtDuration(seconds?: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}

// Escape user/remote text before putting it in an HTML message.
function esc(s?: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// An HTML mention of whoever requested the track.
function mentionOf(ctx: BotContext): string {
  const u = ctx.from;
  if (!u) return '—';
  return `<a href="tg://user?id=${u.id}">${esc(u.first_name || 'مستخدم')}</a>`;
}

// ── Card emojis — change these freely ────────────────────────────────────────
// Each value is rendered as-is inside the HTML caption, so it can be either:
//   • a normal emoji:            title: '🎼'
//   • a premium/custom emoji:    title: '<tg-emoji emoji-id="5368324170671202286">🎵</tg-emoji>'
// To get a custom emoji-id: send that premium emoji to the bot and read the
// message's custom_emoji entity id (or forward it to @userinfobot-style tools).
// Keep a normal emoji as the fallback inside the tag — it shows for non-premium.
const CARD = {
  title: '🎵',
  channel: '👤',
  duration: '⏱',
  requester: '🎧',
  queued: '➕',
  position: '🔢',
  divider: '━━━━━━━━━━━━━',
};
type CardEmoji = typeof CARD;
// Which emojis the /vccard command lets a group change, in order.
const CARD_KEYS = ['title', 'channel', 'duration', 'requester'] as const;

type MsgEntity = { type: string; offset: number; length: number; custom_emoji_id?: string };

// Split a command's text into emoji tokens, turning premium (custom) emoji into
// <tg-emoji> tags so they render animated. Telegram sends a premium emoji as a
// plain fallback glyph in the text plus a custom_emoji entity — without this we
// would store only the fallback glyph.
function emojiTokens(text: string, entities?: MsgEntity[]): string[] {
  const custom = (entities || [])
    .filter((e) => e.type === 'custom_emoji' && e.custom_emoji_id)
    .sort((a, b) => a.offset - b.offset);
  let out = '';
  let i = 0;
  for (const e of custom) {
    if (e.offset < i) continue; // skip overlaps
    out += text.slice(i, e.offset);
    const glyph = text.slice(e.offset, e.offset + e.length);
    out += `<tg-emoji emoji-id="${e.custom_emoji_id}">${esc(glyph)}</tg-emoji>`;
    i = e.offset + e.length;
  }
  out += text.slice(i);
  return out.trim().split(/\s+/).filter(Boolean);
}

// Per-chat emoji overrides (set with /vccard), merged over the defaults.
async function cardEmoji(chatId: number): Promise<CardEmoji> {
  try {
    const s = await getSettings(chatId);
    if (s?.vcCardEmoji) return { ...CARD, ...(JSON.parse(s.vcCardEmoji) as Partial<CardEmoji>) };
  } catch {
    /* bad JSON or no row → defaults */
  }
  return CARD;
}

// The "now playing" card body (used as a photo caption or as a text fallback).
function nowPlayingCaption(r: StreamerResult, mention: string, em: CardEmoji): string {
  return [
    `${em.title} <b>${esc(r.title)}</b>`,
    em.divider,
    `${em.channel} القناة: ${esc(r.uploader) || '—'}`,
    `${em.duration} المدة: ${fmtDuration(r.duration)}`,
    `${em.requester} طلب: ${mention}`,
    em.divider,
  ].join('\n');
}

// Playback controls shown under the card (handled by the vc:* callbacks).
const CONTROLS = Markup.inlineKeyboard([
  [Markup.button.callback('⏸ إيقاف', 'vc:pause'), Markup.button.callback('⏭ تخطي', 'vc:skip')],
  [Markup.button.callback('📜 الطابور', 'vc:queue'), Markup.button.callback('⏹ إنهاء', 'vc:stop')],
]);

// Render the queue as an HTML block (shared by /vcqueue and the 📜 button).
function queueText(r: StreamerResult): string {
  if (!r.active) return '📭 ما في شي عم يشتغل.';
  const lines = [`▶️ الآن: <b>${esc(r.active.title)}</b> (${fmtDuration(r.active.duration)})`];
  if (r.upcoming?.length) {
    lines.push('\n📜 <b>بالطابور:</b>');
    r.upcoming.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${esc(t.title)} (${fmtDuration(t.duration)})`));
    if (r.upcoming.length > 10) lines.push(`… و${r.upcoming.length - 10} غيرها`);
  }
  return lines.join('\n');
}

// Turn a streamer error code into a friendly Arabic line.
function errorText(r: StreamerResult | null): string {
  if (!r) return NOT_CONFIGURED;
  const e = r.error || '';
  if (e === 'unreachable') return '⚠️ ما قدرت أوصل لسيرفر البث. تأكد إنه شغّال.';
  if (e === 'starting') return '🔄 سيرفر البث لسه عم يشتغل، جرّب بعد شوي.';
  if (e === 'not_found') return '❌ ما لقيت الأغنية. جرّب اسم تاني.';
  if (e === 'no_call') return '🔇 الكول مسكّر. افتح كول أول: افتح كول';
  if (e === 'bad_link') return '🔗 رابط الدعوة غلط أو منتهي. جيب رابط دعوة جديد من إعدادات الجروب.';
  if (e === 'wrong_group') return '🔗 هذا الرابط لجروب ثاني، مش لهالجروب. استخدم رابط دعوة نفس الجروب.';
  if (e === 'banned') return '⛔️ الحساب المساعد محظور من هالجروب. فُكّ الحظر عنه وجرّب.';
  if (e === 'too_fast') return '🐌 في محاولة انضمام قريبة. استنى دقيقة وجرّب.';
  if (e === 'flood_wait') return `⏳ تيليجرام طالب انتظار ${r.seconds || 0} ثانية قبل انضمام جديد. جرّب بعدها.`;
  if (e === 'not_member' || /PEER_ID_INVALID|not.*member|CHAT_WRITE_FORBIDDEN/i.test(e))
    return '🔗 الحساب المساعد مش عضو بالجروب. استخدم /vcjoin مع رابط دعوة للجروب، بعدها رقّيه أدمن.';
  if (/CHAT_ADMIN_REQUIRED|RIGHT|ADMIN|FORBIDDEN/i.test(e)) return '⛔️ الحساب المساعد لازم يكون أدمن مع صلاحية إدارة المكالمات.';
  if (/already.?joined/i.test(e)) return 'ℹ️ المساعد عالق بكول قديم. جرّب: سكر كول ← افتح كول ← تشغيل';
  if (/GROUPCALL_INVALID/i.test(e)) return 'ℹ️ في مشكلة بالكول — تأكد إنه مفتوح.';
  return `تعذّر التنفيذ: ${e || 'خطأ غير معروف'}`;
}

async function edit(ctx: BotContext, messageId: number, text: string): Promise<void> {
  if (!ctx.chat) return;
  await ctx.telegram
    .editMessageText(ctx.chat.id, messageId, undefined, text, { parse_mode: 'HTML', disable_web_page_preview: true } as never)
    .catch(() => undefined);
}

export const musicPlugin: Plugin = {
  name: 'music',
  description: 'Play songs inside the group voice chat (via the assistant streamer)',
  commands: [
    { command: 'vcjoin', description: '🔗 ضمّ الحساب المساعد للجروب (مشرف)', staffOnly: true },
    { command: 'vcstart', description: '🎙 افتح كول (مشرف)', staffOnly: true },
    { command: 'vcplay', description: '🎧 تشغيل أغنية بالكول' },
    { command: 'vcskip', description: '⏭ الأغنية التالية (مشرف)', staffOnly: true },
    { command: 'vcpause', description: '⏸ إيقاف مؤقت (مشرف)', staffOnly: true },
    { command: 'vcresume', description: '▶️ استئناف (مشرف)', staffOnly: true },
    { command: 'vcqueue', description: '📜 قائمة تشغيل الكول' },
    { command: 'vccard', description: '🎨 إيموجي بطاقة التشغيل (مشرف)', staffOnly: true },
    { command: 'vcstop', description: '👋 إنهاء الكول (مشرف)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    const groupOnly = (ctx: BotContext): boolean =>
      Boolean(ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'));

    // تشغيل <اسم الأغنية> — anyone can queue a song.
    bot.command('vcplay', async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const parts = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const replied = (ctx.message as { reply_to_message?: { text?: string; caption?: string } }).reply_to_message;
      const query = parts || replied?.text || replied?.caption || '';
      if (!query) return void ctx.reply('🎵 اكتب اسم الأغنية:\nتشغيل نانسي عجرم');
      const status = await ctx.reply(pickSearching());
      const r = await callStreamer('/play', { chat_id: ctx.chat.id, query });
      if (!r?.ok) return void edit(ctx, status.message_id, errorText(r));

      const em = await cardEmoji(ctx.chat.id);

      // Added behind a currently-playing track → a light text card (no photo).
      if (r.queued) {
        return void edit(
          ctx,
          status.message_id,
          `${em.queued} <b>أضيفت للطابور</b>\n${em.title} ${esc(r.title)} (${fmtDuration(r.duration)})\n${em.position} الترتيب: ${r.position}`,
        );
      }

      // Now playing → a photo card with controls; fall back to text if we have
      // no thumbnail or Telegram can't fetch it.
      const caption = nowPlayingCaption(r, mentionOf(ctx), em);
      if (r.thumb) {
        try {
          await ctx.replyWithPhoto(r.thumb, { caption, parse_mode: 'HTML', ...CONTROLS });
          // Edit (not delete) the status line — editing works even when the bot
          // isn't admin, so no vague "searching…" message is left hanging.
          await edit(ctx, status.message_id, '✅ بدأ التشغيل 🎶');
          return;
        } catch (err) {
          log.warn({ err }, 'now-playing photo card failed; using text');
        }
      }
      await ctx.telegram
        .editMessageText(ctx.chat.id, status.message_id, undefined, caption, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...CONTROLS,
        } as never)
        .catch(() => undefined);
    });

    // قائمة التشغيل — anyone can view.
    bot.command('vcqueue', async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/queue', { chat_id: ctx.chat.id });
      if (!r?.ok) return void ctx.reply(errorText(r));
      await ctx.reply(queueText(r), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });

    // Staff-only controls.
    // ضمّ الحساب المساعد للجروب برابط دعوة — لازم يكون عضو قبل ما يفتح الكول.
    bot.command('vcjoin', requireRole('moderator'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const link = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!link || !/^(https?:\/\/)?(t\.me\/|telegram\.me\/)/i.test(link))
        return void ctx.reply('🔗 ابعت رابط دعوة للجروب:\n/vcjoin https://t.me/+xxxxxxxx\nجيبه من: إعدادات الجروب ← روابط الدعوة.');
      const status = await ctx.reply('⏳ عم يحاول ينضم…');
      const r = await callStreamer('/join', { chat_id: ctx.chat.id, invite_link: link });
      if (!r?.ok) return void edit(ctx, status.message_id, errorText(r));
      await edit(
        ctx,
        status.message_id,
        r.already
          ? 'ℹ️ الحساب المساعد أصلاً عضو. رقّيه أدمن مع صلاحية إدارة المكالمات.'
          : '✅ المساعد انضم. هلأ رقّيه أدمن مع صلاحية إدارة المكالمات.',
      );
    });

    bot.command('vcstart', requireRole('moderator'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/startvc', { chat_id: ctx.chat.id });
      await ctx.reply(r?.ok ? '✅ فتحت الكول. اكتب: تشغيل اسم الأغنية' : errorText(r));
    });

    bot.command('vcstop', requireRole('moderator'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/stopvc', { chat_id: ctx.chat.id });
      await ctx.reply(r?.ok ? '👋 سكّرت الكول.' : errorText(r));
    });

    bot.command('vcskip', requireRole('moderator'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/skip', { chat_id: ctx.chat.id });
      if (!r?.ok) return void ctx.reply(errorText(r));
      await ctx.reply(r.ended ? '⏭ خلص الطابور — طلعت من الكول.' : `⏭ التالي: <b>${r.title}</b> (${fmtDuration(r.duration)})`, { parse_mode: 'HTML' });
    });

    bot.command('vcpause', requireRole('moderator'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/pause', { chat_id: ctx.chat.id });
      await ctx.reply(r?.ok ? '⏸ وقّفت مؤقتاً. اكتب: كمل' : 'ما في شي عم يشتغل.');
    });

    bot.command('vcresume', requireRole('moderator'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/resume', { chat_id: ctx.chat.id });
      await ctx.reply(r?.ok ? '▶️ كمّلت.' : 'ما في شي موقوف.');
    });

    // بطاقة 🎼 🎤 ⏳ 💿 — set the card emojis (title channel duration requester).
    // No args → reset to defaults. Moderators only.
    bot.command('vccard', requireRole('moderator'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      const title = 'title' in ctx.chat ? ctx.chat.title : undefined;
      await ensureChat(ctx.chat.id, title, ctx.chat.type);

      const entities = (ctx.message as { entities?: MsgEntity[] }).entities;
      const tokens = emojiTokens(ctx.message.text, entities).slice(1); // drop the command word
      if (!tokens.length) {
        await setVcCardEmoji(ctx.chat.id, null);
        return void ctx.reply('✅ رجّعت إيموجي البطاقة للافتراضي.\nلتغييرها: بطاقة 🎼 🎤 ⏳ 💿');
      }

      // Positional: title, channel, duration, requester (extra tokens ignored).
      const overrides: Partial<CardEmoji> = {};
      tokens.slice(0, CARD_KEYS.length).forEach((tok, i) => {
        overrides[CARD_KEYS[i]] = tok;
      });
      await setVcCardEmoji(ctx.chat.id, JSON.stringify(overrides));

      const em = { ...CARD, ...overrides };
      await ctx.reply(
        `✅ غيّرت إيموجي البطاقة:\n${em.title} العنوان · ${em.channel} القناة · ${em.duration} المدة · ${em.requester} الطلب\n\nجرّب: تشغيل اسم الأغنية`,
        { parse_mode: 'HTML' },
      );
    });

    // Inline card buttons (⏸ ⏭ 📜 ⏹). Moderators only — enforced here since
    // callbacks don't run the command middleware.
    bot.action(/^vc:(pause|skip|queue|stop)$/, async (ctx) => {
      const action = ctx.match?.[1];
      if (!ctx.chat) return void ctx.answerCbQuery().catch(() => undefined);
      if (!STREAMER_URL) return void ctx.answerCbQuery(NOT_CONFIGURED).catch(() => undefined);

      const role = await resolveRole(ctx);
      if (!hasRole(role, 'moderator')) {
        return void ctx.answerCbQuery('⛔️ الأزرار للمشرفين فقط.').catch(() => undefined);
      }

      const chatId = ctx.chat.id;
      if (action === 'pause') {
        const r = await callStreamer('/pause', { chat_id: chatId });
        return void ctx.answerCbQuery(r?.ok ? '⏸ وقّفت مؤقتاً.' : 'ما في شي عم يشتغل.').catch(() => undefined);
      }
      if (action === 'skip') {
        const r = await callStreamer('/skip', { chat_id: chatId });
        if (!r?.ok) return void ctx.answerCbQuery(errorText(r)).catch(() => undefined);
        return void ctx
          .answerCbQuery(r.ended ? '⏭ خلص الطابور — طلعت من الكول.' : `⏭ التالي: ${r.title}`)
          .catch(() => undefined);
      }
      if (action === 'stop') {
        const r = await callStreamer('/stop', { chat_id: chatId });
        return void ctx.answerCbQuery(r?.ok ? '⏹ أنهيت الكول.' : errorText(r)).catch(() => undefined);
      }
      // queue → answer the toast, then post the list as a fresh message.
      const r = await callStreamer('/queue', { chat_id: chatId });
      await ctx.answerCbQuery().catch(() => undefined);
      if (!r?.ok) return void ctx.reply(errorText(r));
      await ctx.reply(queueText(r), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });
  },
};
