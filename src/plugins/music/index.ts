import { Markup, type Telegraf, type Telegram } from 'telegraf';
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

// ── Card emojis ──────────────────────────────────────────────────────────────
// An emoji slot is a fallback glyph plus an optional custom (premium) emoji id.
// Premium emoji are sent via message ENTITIES (like the id card), not HTML — a
// <tg-emoji> tag is unreliable here, entities are what Telegram actually accepts.
type EmojiVal = { e: string; id?: string };
type Entity = {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
  user?: unknown;
};

const CARD_KEYS = ['title', 'channel', 'duration', 'requester'] as const;
type CardKey = (typeof CARD_KEYS)[number];
type CardEmoji = Record<CardKey, EmojiVal>;

const CARD_DEFAULT: CardEmoji = {
  title: { e: '🎵' },
  channel: { e: '👤' },
  duration: { e: '⏱' },
  requester: { e: '🎧' },
};
const EXTRA = { queued: '➕', position: '🔢', divider: '━━━━━━━━━━━━━' };

// Per-chat emoji overrides (set with /vccard), merged over the defaults.
async function cardEmoji(chatId: number): Promise<CardEmoji> {
  try {
    const s = await getSettings(chatId);
    if (s?.vcCardEmoji) return { ...CARD_DEFAULT, ...(JSON.parse(s.vcCardEmoji) as Partial<CardEmoji>) };
  } catch {
    /* bad JSON or no row → defaults */
  }
  return CARD_DEFAULT;
}

// Assemble caption text while tracking UTF-16 offsets for entities (bold,
// custom_emoji, text_mention) — the same mechanism the id card uses.
class CaptionBuilder {
  text = '';
  entities: Entity[] = [];
  add(s: string): this {
    this.text += s;
    return this;
  }
  emoji(v: EmojiVal): this {
    const offset = this.text.length;
    this.text += v.e;
    if (v.id) this.entities.push({ type: 'custom_emoji', offset, length: v.e.length, custom_emoji_id: v.id });
    return this;
  }
  bold(s: string): this {
    const offset = this.text.length;
    this.text += s;
    this.entities.push({ type: 'bold', offset, length: s.length });
    return this;
  }
  mention(name: string, user: unknown): this {
    const offset = this.text.length;
    this.text += name;
    this.entities.push({ type: 'text_mention', offset, length: name.length, user });
    return this;
  }
}

type Requester = { name: string; user: unknown } | null;

// Build the "now playing" card as text + entities. requester is who asked for
// the track (null for auto-advance, which shows "تلقائي").
function nowPlayingCard(r: StreamerResult, requester: Requester, em: CardEmoji): { text: string; entities: Entity[] } {
  const b = new CaptionBuilder();
  b.emoji(em.title).add(' ').bold(r.title || '').add('\n');
  b.add(`${EXTRA.divider}\n`);
  b.emoji(em.channel).add(` القناة: ${r.uploader || '—'}\n`);
  b.emoji(em.duration).add(` المدة: ${fmtDuration(r.duration)}\n`);
  b.emoji(em.requester).add(' طلب: ');
  if (requester) b.mention(requester.name || 'مستخدم', requester.user);
  else b.add('تلقائي');
  b.add(`\n${EXTRA.divider}`);
  return { text: b.text, entities: b.entities };
}

const reqOf = (ctx: BotContext): Requester => (ctx.from ? { name: ctx.from.first_name || 'مستخدم', user: ctx.from } : null);

// Edit a status message to text+entities, retrying without custom_emoji (premium
// emoji fail if the bot owner lacks Premium) and finally with no entities — so
// it always renders and never stays stuck on the "searching…" line.
async function editEntities(
  ctx: BotContext,
  id: number,
  text: string,
  entities: Entity[],
  extra: object = {},
): Promise<void> {
  if (!ctx.chat) return;
  const plain = entities.filter((e) => e.type !== 'custom_emoji');
  for (const ents of [entities, plain, [] as Entity[]]) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, id, undefined, text, {
        entities: ents as never,
        link_preview_options: { is_disabled: true },
        ...extra,
      } as never);
      return;
    } catch {
      /* try the next, less-decorated variant */
    }
  }
}

// Send the now-playing card: a photo if we have a thumbnail, else edit the
// status message to text. Retries without custom_emoji if premium is rejected.
async function sendNowPlaying(ctx: BotContext, statusId: number, r: StreamerResult, em: CardEmoji): Promise<void> {
  const { text, entities } = nowPlayingCard(r, reqOf(ctx), em);
  const plain = entities.filter((e) => e.type !== 'custom_emoji');
  if (r.thumb) {
    for (const ents of [entities, plain]) {
      try {
        await ctx.replyWithPhoto(r.thumb, { caption: text, caption_entities: ents as never, ...CONTROLS });
        // Edit (not delete) the status line — works even when the bot isn't
        // admin, so no vague "searching…" message is left hanging.
        await edit(ctx, statusId, '✅ بدأ التشغيل 🎶');
        return;
      } catch (err) {
        log.warn({ err }, 'now-playing photo failed; retry/fallback');
        if (ents === plain) break;
      }
    }
  }
  await editEntities(ctx, statusId, text, entities, CONTROLS);
}

// Post the now-playing card as a FRESH message via a raw Telegram instance —
// usable without a ctx (e.g. the streamer's auto-advance callback). Same
// premium-emoji fallback: retry without custom_emoji, then with no entities.
export async function sendCardVia(
  telegram: Telegram,
  chatId: number,
  r: StreamerResult,
  requester: Requester,
): Promise<void> {
  const em = await cardEmoji(chatId);
  const { text, entities } = nowPlayingCard(r, requester, em);
  const plain = entities.filter((e) => e.type !== 'custom_emoji');
  const kb = { reply_markup: CONTROLS.reply_markup };
  if (r.thumb) {
    for (const ents of [entities, plain]) {
      try {
        await telegram.sendPhoto(chatId, r.thumb, { caption: text, caption_entities: ents as never, ...kb });
        return;
      } catch (err) {
        log.warn({ err }, 'card photo failed; retry/fallback');
        if (ents === plain) break;
      }
    }
  }
  for (const ents of [entities, plain, [] as Entity[]]) {
    try {
      await telegram.sendMessage(chatId, text, {
        entities: ents as never,
        link_preview_options: { is_disabled: true },
        ...kb,
      } as never);
      return;
    } catch {
      /* try the next, less-decorated variant */
    }
  }
}

// Post the card as a fresh message in the current chat (skip / next-track).
async function postCard(ctx: BotContext, r: StreamerResult): Promise<void> {
  if (!ctx.chat) return;
  await sendCardVia(ctx.telegram, ctx.chat.id, r, reqOf(ctx));
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
        const b = new CaptionBuilder();
        b.add(`${EXTRA.queued} `).bold('أضيفت للطابور').add('\n');
        b.emoji(em.title).add(` ${r.title} (${fmtDuration(r.duration)})\n`);
        b.add(`${EXTRA.position} الترتيب: ${r.position}`);
        return void editEntities(ctx, status.message_id, b.text, b.entities);
      }

      // Now playing → a photo card with controls (text fallback with no thumb).
      await sendNowPlaying(ctx, status.message_id, r, em);
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
      if (r.ended) return void ctx.reply('⏭ خلص الطابور — طلعت من الكول.');
      await postCard(ctx, r);
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

      // Each whitespace-separated arg is one emoji; a premium one carries a
      // custom_emoji entity at the same offset — capture its id.
      const entities = ((ctx.message as { entities?: Entity[] }).entities || []).filter(
        (e) => e.type === 'custom_emoji' && e.custom_emoji_id,
      );
      const customByOffset = new Map(entities.map((e) => [e.offset, e]));
      const text = ctx.message.text;
      const words: { e: string; id?: string }[] = [];
      const re = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const ce = customByOffset.get(m.index);
        words.push(ce && ce.length === m[0].length ? { e: m[0], id: ce.custom_emoji_id } : { e: m[0] });
      }
      const args = words.slice(1); // drop the command word

      if (!args.length) {
        await setVcCardEmoji(ctx.chat.id, null);
        return void ctx.reply('✅ رجّعت إيموجي البطاقة للافتراضي.\nلتغييرها: بطاقة 🎼 🎤 ⏳ 💿');
      }

      // Positional: title, channel, duration, requester (extra args ignored).
      const overrides: Partial<CardEmoji> = {};
      args.slice(0, CARD_KEYS.length).forEach((v, i) => {
        overrides[CARD_KEYS[i]] = v;
      });
      await setVcCardEmoji(ctx.chat.id, JSON.stringify(overrides));

      // Confirm with the actual emoji (entities) so a premium one shows here too.
      const em = { ...CARD_DEFAULT, ...overrides };
      const b = new CaptionBuilder();
      b.add('✅ غيّرت إيموجي البطاقة:\n');
      b.emoji(em.title).add(' العنوان · ').emoji(em.channel).add(' القناة · ');
      b.emoji(em.duration).add(' المدة · ').emoji(em.requester).add(' الطلب');
      b.add('\n\nجرّب: تشغيل اسم الأغنية');
      const plain = b.entities.filter((e) => e.type !== 'custom_emoji');
      await ctx
        .reply(b.text, { entities: b.entities as never })
        .catch(() => ctx.reply(b.text, { entities: plain as never }).catch(() => ctx.reply(b.text)));
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
        await ctx.answerCbQuery(r.ended ? '⏭ خلص الطابور — طلعت من الكول.' : '⏭ التالي').catch(() => undefined);
        if (!r.ended) await postCard(ctx, r);
        return;
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
