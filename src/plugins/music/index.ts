import { Input, Markup, type Telegraf, type Telegram } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { renderSongCard } from '../../services/card/song';
import { requireRole, resolveRole, hasRole } from '../../utils/permissions';
import { ensureChat, getSettings, setVcCardEmoji } from '../../services/settings.service';
import { getGlobalVcCardEmoji, setGlobalVcCardEmoji } from '../../services/global.service';
import { getEmojiMap, setEmojiMap } from '../../services/emojiMap';
import { createLogger } from '../../core/logger';
import { env } from '../../config/env';

const log = createLogger('plugin:music');

// The headless streamer service (music-bot/) that owns the assistant account and
// streams into voice chats. Configure these on the bot's environment:
//   STREAMER_URL=http://host:8080   STREAMER_TOKEN=<shared secret>
const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

// A clickable developer link for the "coming soon" notice: DEV_CONTACT /
// SUPPORT_CONTACT (@user / username / URL), else a tg://user link to the owner.
const DEV_LINK = (() => {
  const c = (env.DEV_CONTACT || env.SUPPORT_CONTACT || '').trim();
  if (c) {
    if (/^https?:\/\//i.test(c) || /^tg:\/\//i.test(c)) return c;
    const u = c.replace(/^@/, '');
    if (/^[a-zA-Z0-9_]{4,32}$/.test(u)) return `https://t.me/${u}`;
  }
  const owner = env.OWNER_IDS[0];
  return owner ? `tg://user?id=${owner}` : '';
})();

// A friendly "coming soon" notice (the old one exposed STREAMER_URL internals).
const NOT_CONFIGURED =
  '🎧 <b>خدمة التشغيل بالكول قريباً!</b>\n' +
  '✦ ┈┈┈┈┈┈┈┈ ✦\n' +
  'عم نجهّزها لتشغيل الأغاني داخل المكالمة، ورح تكون متاحة قريباً بإذن الله. 🎶' +
  (DEV_LINK ? `\n\n👨‍💻 للاستفسار أو التواصل: <a href="${DEV_LINK}">المطوّر</a>` : '');

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
  removed?: number;
  seconds?: number;
  assistant_id?: number;
  title?: string;
  duration?: number;
  thumb?: string;
  uploader?: string;
  active?: { title: string; duration: number } | null;
  upcoming?: { title: string; duration: number }[];
}

/** GET /health once — used to wake and detect a cold (spun-down) streamer. */
async function pingHealth(timeoutMs = 8000): Promise<boolean> {
  if (!STREAMER_URL) return false;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(`${STREAMER_URL}/health`, { signal: c.signal }).finally(() => clearTimeout(t));
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Render free spins the streamer down after ~15 min idle; a cold start takes
 * ~30-60s. Rather than keep it always-on (which wouldn't fit the free
 * instance-hours), we let it sleep and wake it on demand: poll /health until it
 * answers. Returns true once awake.
 */
async function wakeStreamer(): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await pingHealth()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

type Attempt = StreamerResult | { cold: true } | null;

async function streamerAttempt(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Attempt> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    // 5xx during a cold start returns a non-JSON page → treat as "cold" and wake.
    if (!res.ok) return res.status >= 500 ? { cold: true } : { ok: false, error: 'bad_response' };
    return (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as StreamerResult;
  } catch (err) {
    log.warn({ err, path }, 'streamer call failed');
    return { cold: true }; // network error / abort → the service is likely asleep
  }
}

let wakingInFlight = false;

async function callStreamer(path: string, body: Record<string, unknown>): Promise<StreamerResult | null> {
  if (!STREAMER_URL) return null;
  const r = await streamerAttempt(path, body, 20_000);
  if (r && 'cold' in r) {
    // Asleep/cold. A Render cold start takes ~30-60s — longer than the bot's
    // 30s handler timeout — so we CAN'T wake-and-play in one request. Warm it in
    // the background and ask the user to retry, instead of hanging the handler.
    if (!wakingInFlight) {
      wakingInFlight = true;
      void wakeStreamer()
        .catch(() => false)
        .finally(() => {
          wakingInFlight = false;
        });
    }
    return { ok: false, error: 'waking' };
  }
  return r;
}

function isNotMember(r: StreamerResult | null): boolean {
  const e = r?.error || '';
  return e === 'not_member' || /PEER_ID_INVALID|not.*member|CHAT_WRITE_FORBIDDEN/i.test(e);
}

// Add the assistant to this group automatically: the bot creates a one-use
// invite link, the streamer joins with it, then the bot promotes the assistant
// to admin (voice-chat management). Best-effort — returns the join result.
async function autoAddAssistant(ctx: BotContext): Promise<StreamerResult | null> {
  if (!ctx.chat) return null;
  const chatId = ctx.chat.id;
  let inviteLink: string;
  try {
    const res = await ctx.telegram.createChatInviteLink(chatId, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 600,
    });
    inviteLink = res.invite_link;
  } catch {
    return { ok: false, error: 'bot_cant_invite' };
  }
  const r = await callStreamer('/join', { chat_id: chatId, invite_link: inviteLink });
  if ((r?.ok || r?.already) && r?.assistant_id) {
    // Promote so it can manage voice chats. If the bot lacks "add admins" this
    // silently no-ops and the user can promote manually.
    await ctx.telegram
      .promoteChatMember(chatId, r.assistant_id, { can_manage_video_chats: true })
      .catch(() => undefined);
  }
  return r;
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

// Resolve the card emojis: defaults → bot-wide global (set by owner) → this
// group's own override (set with /vccard), each layer winning over the last.
async function cardEmoji(chatId: number): Promise<CardEmoji> {
  const merged: CardEmoji = { ...CARD_DEFAULT };
  try {
    const g = await getGlobalVcCardEmoji();
    if (g) Object.assign(merged, g);
  } catch {
    /* ignore */
  }
  try {
    const s = await getSettings(chatId);
    if (s?.vcCardEmoji) Object.assign(merged, JSON.parse(s.vcCardEmoji) as Partial<CardEmoji>);
  } catch {
    /* bad JSON or no row → keep what we have */
  }
  return merged;
}

type RepliedMsg = { text?: string; caption?: string; entities?: Entity[]; caption_entities?: Entity[] };
const repliedText = (m: RepliedMsg): string => m.text || m.caption || '';
const repliedEntities = (m: RepliedMsg): Entity[] | undefined => m.entities || m.caption_entities;

// Parse a message's text into emoji values, capturing premium (custom) emoji
// ids from its entities. Each whitespace-separated word is one emoji.
function parseEmojiVals(text: string, entities?: Entity[]): EmojiVal[] {
  const custom = new Map<number, Entity>();
  for (const e of entities || []) if (e.type === 'custom_emoji' && e.custom_emoji_id) custom.set(e.offset, e);
  const out: EmojiVal[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ce = custom.get(m.index);
    out.push(ce && ce.length === m[0].length ? { e: m[0], id: ce.custom_emoji_id } : { e: m[0] });
  }
  return out;
}

// Turn positional emoji args into a { title, channel, duration, requester }
// override object (extra args ignored).
function toOverrides(args: EmojiVal[]): Partial<CardEmoji> {
  const o: Partial<CardEmoji> = {};
  args.slice(0, CARD_KEYS.length).forEach((v, i) => {
    o[CARD_KEYS[i]] = v;
  });
  return o;
}

// Send a confirmation showing the actual emoji (via entities), degrading to the
// plain glyphs if a premium one can't be sent.
async function replyEmojiConfirm(ctx: BotContext, header: string, ov: Partial<CardEmoji>): Promise<void> {
  const em = { ...CARD_DEFAULT, ...ov };
  const b = new CaptionBuilder();
  b.add(`${header}\n`);
  b.emoji(em.title).add(' العنوان · ').emoji(em.channel).add(' القناة · ');
  b.emoji(em.duration).add(' المدة · ').emoji(em.requester).add(' الطلب');
  const plain = b.entities.filter((e) => e.type !== 'custom_emoji');
  await ctx
    .reply(b.text, { entities: b.entities as never })
    .catch(() => ctx.reply(b.text, { entities: plain as never }).catch(() => ctx.reply(b.text)));
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

// A replied message that may carry a voice/audio to play directly in the call.
type RepliedForPlay = {
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number };
  audio?: { file_id: string; duration?: number; title?: string; performer?: string };
  video_note?: { file_id: string; duration?: number };
  document?: { file_id: string; mime_type?: string; file_name?: string };
};

/** Extract a playable audio file from a replied message, or null. */
function repliedAudio(m?: RepliedForPlay): { fileId: string; title: string; duration: number } | null {
  if (!m) return null;
  if (m.voice) return { fileId: m.voice.file_id, title: 'مقطع صوتي', duration: m.voice.duration ?? 0 };
  if (m.audio)
    return { fileId: m.audio.file_id, title: m.audio.title || m.audio.performer || 'أغنية', duration: m.audio.duration ?? 0 };
  if (m.video_note) return { fileId: m.video_note.file_id, title: 'مقطع', duration: m.video_note.duration ?? 0 };
  if (m.document && /^audio\//.test(m.document.mime_type || ''))
    return { fileId: m.document.file_id, title: m.document.file_name || 'مقطع صوتي', duration: 0 };
  return null;
}

// The bot's @handle for the card footer (fetched once, cached).
let cachedHandle: string | null = null;
async function botHandle(telegram: Telegram): Promise<string | undefined> {
  if (cachedHandle === null)
    cachedHandle = await telegram.getMe().then((m) => (m.username ? `@${m.username}` : '')).catch(() => '');
  return cachedHandle || undefined;
}

// Caption under the now-playing image: a decorated "userbot" word + the bot's
// name as a clickable mention (the interceptor turns the <a> into a real link).
let cachedSig: string | null = null;
async function botSignature(telegram: Telegram): Promise<string> {
  if (cachedSig === null) {
    const me = await telegram.getMe().catch(() => null);
    cachedSig = me
      ? `🎧 𝗨𝗦𝗘𝗥𝗕𝗢𝗧 : <a href="tg://user?id=${me.id}">${esc(me.first_name || me.username || 'Bot')}</a>`
      : '';
  }
  return cachedSig;
}

// Render the premium "now playing" image card. Returns null on any failure so
// callers fall back to the text/thumbnail card.
async function renderNowPlayingImage(
  telegram: Telegram,
  r: StreamerResult,
  requester: Requester,
): Promise<Buffer | null> {
  try {
    return await renderSongCard({
      title: r.title || '—',
      uploader: r.uploader,
      duration: fmtDuration(r.duration),
      requester: requester?.name || 'تلقائي',
      coverUrl: r.thumb,
      handle: await botHandle(telegram),
    });
  } catch (err) {
    log.warn({ err }, 'now-playing card render failed');
    return null;
  }
}

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
  // Premium image card first; fall back to the text/thumbnail card on failure.
  const img = await renderNowPlayingImage(ctx.telegram, r, reqOf(ctx));
  if (img) {
    try {
      const caption = await botSignature(ctx.telegram);
      await ctx.replyWithPhoto(Input.fromBuffer(img, 'nowplaying.jpg'), { caption, ...CONTROLS });
      await edit(ctx, statusId, '✅ بدأ التشغيل 🎶');
      return;
    } catch (err) {
      log.warn({ err }, 'now-playing image send failed; falling back');
    }
  }
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
  const kb = { reply_markup: CONTROLS.reply_markup };
  // Premium image card first; fall back to the text/thumbnail card on failure.
  const img = await renderNowPlayingImage(telegram, r, requester);
  if (img) {
    try {
      const caption = await botSignature(telegram);
      await telegram.sendPhoto(chatId, Input.fromBuffer(img, 'nowplaying.jpg'), { caption, ...kb });
      return;
    } catch (err) {
      log.warn({ err }, 'card image send failed; falling back');
    }
  }
  const em = await cardEmoji(chatId);
  const { text, entities } = nowPlayingCard(r, requester, em);
  const plain = entities.filter((e) => e.type !== 'custom_emoji');
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
  [Markup.button.callback('🟡 ⏸ إيقاف', 'vc:pause'), Markup.button.callback('🔵 ⏭ تخطي', 'vc:skip')],
  [Markup.button.callback('🟢 📜 الطابور', 'vc:queue'), Markup.button.callback('🔴 ⏹ إنهاء', 'vc:stop')],
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
  if (e === 'bad_index') return '❌ رقم غلط. شوف الطابور بأمر: قائمة الكول';
  if (e === 'no_call') return '🔇 الكول مسكّر. افتح كول أول: افتح كول';
  if (e === 'bot_cant_invite') return '⚠️ خلّي البوت أدمن مع صلاحية «دعوة أعضاء عبر رابط» عشان يضيف المساعد لحاله.';
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
  if (e === 'waking') return '🔄 خدمة الكول كانت نايمة وعم تصحى (بتاخد ~دقيقة). أعِد «تشغيل» بعد شوي 🎶';
  if (e === 'bad_response') return '🔄 خدمة الكول عم تصحى أو ردّت بشكل غير متوقّع. جرّب بعد دقيقة، وإذا استمرّت راجع سيرفر الكول.';
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
    { command: 'vcremove', description: '🗑 احذف أغنية من الطابور (مشرف)', staffOnly: true },
    { command: 'vcclear', description: '🧹 فرّغ الطابور (مشرف)', staffOnly: true },
    { command: 'vccard', description: '🎨 إيموجي بطاقة التشغيل (مشرف)', staffOnly: true },
    { command: 'vccardall', description: '🌐 إيموجي البطاقة لكل البوت (مالك)', staffOnly: true },
    { command: 'premiumemoji', description: '✨ حوّل إيموجي لمميّز بكل البوت (مالك)', staffOnly: true },
    { command: 'vcstop', description: '👋 إنهاء الكول (مشرف)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    const groupOnly = (ctx: BotContext): boolean =>
      Boolean(ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'));

    // تشغيل <اسم الأغنية> — anyone can queue a song.
    bot.command('vcplay', async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const chatId = ctx.chat.id;
      const parts = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const replied = (ctx.message as { reply_to_message?: RepliedForPlay }).reply_to_message;
      const media = parts ? null : repliedAudio(replied);

      // Build the play call: a replied voice/audio → /playfile (direct URL, no
      // search); otherwise the normal search flow. Same response handling below.
      let status: { message_id: number };
      let playCall: () => Promise<StreamerResult | null>;
      if (media) {
        status = await ctx.reply('🎧 <b>عم شغّل المقطع بالكول…</b>');
        const link = await ctx.telegram.getFileLink(media.fileId).catch(() => null);
        if (!link) return void edit(ctx, status.message_id, '⚠️ تعذّر جلب الملف (قد يكون كبيراً جداً).');
        playCall = () =>
          callStreamer('/playfile', { chat_id: chatId, url: link.toString(), title: media.title, duration: media.duration });
      } else {
        const query = parts || replied?.text || replied?.caption || '';
        if (!query) return void ctx.reply('🎵 <b>اكتب اسم الأغنية:</b>\n<code>تشغيل نانسي عجرم</code>\nأو ردّ على مقطع صوتي بـ <code>تشغيل</code>.');
        status = await ctx.reply(pickSearching());
        playCall = () => callStreamer('/play', { chat_id: chatId, query });
      }

      let r = await playCall();
      if (isNotMember(r)) {
        await edit(ctx, status.message_id, '⏳ عم ضيف الحساب المساعد للجروب…');
        const j = await autoAddAssistant(ctx);
        if (!(j?.ok || j?.already)) return void edit(ctx, status.message_id, errorText(j));
        r = await playCall();
      }
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
    bot.command('vcjoin', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const link = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!link || !/^(https?:\/\/)?(t\.me\/|telegram\.me\/)/i.test(link))
        return void ctx.reply('🔗 <b>ابعت رابط دعوة للجروب:</b>\n<code>/vcjoin https://t.me/+xxxxxxxx</code>\nجيبه من: إعدادات الجروب ← روابط الدعوة.');
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

    bot.command('vcstart', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      let r = await callStreamer('/startvc', { chat_id: ctx.chat.id });
      if (isNotMember(r)) {
        const status = await ctx.reply('⏳ عم ضيف الحساب المساعد للجروب…');
        const j = await autoAddAssistant(ctx);
        if (!(j?.ok || j?.already)) return void edit(ctx, status.message_id, errorText(j));
        await edit(ctx, status.message_id, '✅ ضفت المساعد وعم افتح الكول…');
        r = await callStreamer('/startvc', { chat_id: ctx.chat.id });
      }
      await ctx.reply(r?.ok ? '✅ <b>فتحت الكول!</b>\nاكتب: <code>تشغيل اسم الأغنية</code>' : errorText(r));
    });

    bot.command('vcstop', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/stopvc', { chat_id: ctx.chat.id });
      await ctx.reply(r?.ok ? '👋 <b>سكّرت الكول.</b>' : errorText(r));
    });

    bot.command('vcskip', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/skip', { chat_id: ctx.chat.id });
      if (!r?.ok) return void ctx.reply(errorText(r));
      if (r.ended) return void ctx.reply('⏭ <b>خلص الطابور</b> — طلعت من الكول.');
      await postCard(ctx, r);
    });

    bot.command('vcpause', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/pause', { chat_id: ctx.chat.id });
      await ctx.reply(r?.ok ? '⏸ <b>وقّفت مؤقتاً.</b> اكتب: <code>كمل</code>' : '🔇 ما في شي عم يشتغل.');
    });

    bot.command('vcresume', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/resume', { chat_id: ctx.chat.id });
      await ctx.reply(r?.ok ? '▶️ <b>كمّلت.</b>' : '⏹ ما في شي موقوف.');
    });

    // فرّغ الطابور (بيضل الي عم يشتغل).
    bot.command('vcclear', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/clearqueue', { chat_id: ctx.chat.id });
      if (!r?.ok) return void ctx.reply(errorText(r));
      await ctx.reply(r.removed ? `🧹 <b>فرّغت الطابور</b> (${r.removed} أغنية). الي عم يشتغل بيكمّل.` : '📭 الطابور أصلاً فاضي.');
    });

    // احذف أغنية من الطابور برقمها: احذف 3
    bot.command('vcremove', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const index = parseInt(ctx.message.text.split(/\s+/)[1] || '', 10);
      if (!index || index < 1) return void ctx.reply('🗑 <b>اكتب رقم الأغنية بالطابور:</b>\n<code>احذف 3</code>\n(شوف الأرقام بأمر: قائمة الكول)');
      const r = await callStreamer('/remove', { chat_id: ctx.chat.id, index });
      if (!r?.ok) return void ctx.reply(errorText(r));
      await ctx.reply(`🗑 حذفت: <b>${esc(r.title)}</b> (${fmtDuration(r.duration)})`, { parse_mode: 'HTML' });
    });

    // بطاقة 🎼 🎤 ⏳ 💿 — set the card emojis (title channel duration requester).
    // No args → reset to defaults. Moderators only.
    bot.command('vccard', requireRole('admin'), async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      const title = 'title' in ctx.chat ? ctx.chat.title : undefined;
      await ensureChat(ctx.chat.id, title, ctx.chat.type);

      // Args come from the command text OR, if it's a reply, the replied-to
      // message (reliable for premium emoji — replies aren't alias-rewritten).
      const replied = (ctx.message as { reply_to_message?: RepliedMsg }).reply_to_message;
      let args: EmojiVal[];
      if (replied) {
        args = parseEmojiVals(repliedText(replied), repliedEntities(replied));
      } else {
        args = parseEmojiVals(ctx.message.text, (ctx.message as { entities?: Entity[] }).entities).slice(1);
      }

      if (!args.length) {
        await setVcCardEmoji(ctx.chat.id, null);
        return void ctx.reply('✅ رجّعت إيموجي البطاقة للافتراضي.\nلتغييرها: بطاقة 🎼 🎤 ⏳ 💿 (أو رُدّ على رسالة فيها الإيموجي)');
      }

      const overrides = toOverrides(args);
      await setVcCardEmoji(ctx.chat.id, JSON.stringify(overrides));
      await replyEmojiConfirm(ctx, '✅ غيّرت إيموجي البطاقة لهالجروب:', overrides);
    });

    // ايموجي عام — set the card emojis for the WHOLE bot. Reply to a message that
    // contains the emoji (the reliable way for premium ones). Owner only; a
    // per-group /vccard still overrides this. No reply → reset to defaults.
    bot.command('vccardall', requireRole('founder'), async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: RepliedMsg }).reply_to_message;
      if (!replied) {
        await setGlobalVcCardEmoji(null);
        return void ctx.reply('✅ رجّعت الإيموجي العام للافتراضي.\nلتعيينه: رُدّ على رسالة فيها الإيموجي واكتب: ايموجي عام');
      }
      const args = parseEmojiVals(repliedText(replied), repliedEntities(replied));
      if (!args.length) {
        return void ctx.reply('🤷 الرسالة اللي رديت عليها ما فيها إيموجي.\nرُدّ على رسالة فيها الإيموجي بالترتيب: العنوان القناة المدة الطلب.');
      }
      const overrides = toOverrides(args);
      await setGlobalVcCardEmoji(overrides as Record<string, unknown>);
      await replyEmojiConfirm(ctx, '✅ حفظت الإيموجي لكل البوت:', overrides);
    });

    // مميز — upgrade a normal emoji to premium across ALL bot messages. Send (or
    // reply to a message with) the premium emoji; its plain fallback glyph is
    // mapped to it everywhere. Owner only. "مميز مسح" clears the whole map.
    bot.command('premiumemoji', requireRole('founder'), async (ctx) => {
      const replied = (ctx.message as { reply_to_message?: RepliedMsg }).reply_to_message;
      const text = replied ? repliedText(replied) : ctx.message.text;
      const ents = replied ? repliedEntities(replied) : (ctx.message as { entities?: Entity[] }).entities;
      const customs = (ents || []).filter((e) => e.type === 'custom_emoji' && e.custom_emoji_id);
      if (!customs.length) {
        if (/مسح|clear|reset|صفر/i.test(text)) {
          await setEmojiMap({});
          return void ctx.reply('🧹 مسحت كل تبديلات الإيموجي المميّز.');
        }
        return void ctx.reply(
          '✨ لتخلّي إيموجي عادي يصير مميّز بكل رسائل البوت:\n' +
            'ابعت (أو رُدّ على رسالة فيها) الإيموجي المميّز واكتب: مميز\n' +
            'كل إيموجي مميّز رح يستبدل نسخته العادية بكل مكان.\n\nللمسح: مميز مسح',
        );
      }
      const map = { ...getEmojiMap() };
      let n = 0;
      for (const e of customs) {
        const g = text.slice(e.offset, e.offset + e.length);
        if (g && e.custom_emoji_id) {
          map[g] = e.custom_emoji_id;
          n++;
        }
      }
      await setEmojiMap(map);
      await ctx.reply(`✅ سجّلت ${n} إيموجي. من هلأ نسخته العادية رح تطلع مميّزة بكل رسائل البوت.`);
    });

    // Inline card buttons (⏸ ⏭ 📜 ⏹). Moderators only — enforced here since
    // callbacks don't run the command middleware.
    bot.action(/^vc:(pause|skip|queue|stop)$/, async (ctx) => {
      const action = ctx.match?.[1];
      if (!ctx.chat) return void ctx.answerCbQuery().catch(() => undefined);
      if (!STREAMER_URL) return void ctx.answerCbQuery(NOT_CONFIGURED).catch(() => undefined);

      const role = await resolveRole(ctx);
      if (!hasRole(role, 'admin')) {
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
