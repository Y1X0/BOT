import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:music');

// The headless streamer service (music-bot/) that owns the assistant account and
// streams into voice chats. Configure these on the bot's environment:
//   STREAMER_URL=http://host:8080   STREAMER_TOKEN=<shared secret>
const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

const NOT_CONFIGURED =
  '🎧 خدمة الكول مش مفعّلة بعد.\nلازم يشتغل سيرفر البث (music-bot) ويُضبط STREAMER_URL على البوت.';

interface StreamerResult {
  ok: boolean;
  error?: string;
  queued?: boolean;
  position?: number;
  ended?: boolean;
  title?: string;
  duration?: number;
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

// Turn a streamer error code into a friendly Arabic line.
function errorText(r: StreamerResult | null): string {
  if (!r) return NOT_CONFIGURED;
  const e = r.error || '';
  if (e === 'unreachable') return '⚠️ ما قدرت أوصل لسيرفر البث. تأكد إنه شغّال.';
  if (e === 'not_found') return '❌ ما لقيت الأغنية. جرّب اسم تاني.';
  if (/CHAT_ADMIN_REQUIRED|RIGHT|ADMIN/i.test(e)) return '⛔️ الحساب المساعد لازم يكون أدمن مع صلاحية إدارة المكالمات.';
  if (/GROUPCALL_INVALID|already/i.test(e)) return 'ℹ️ في مشكلة بالكول — تأكد إنه مفتوح.';
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
    { command: 'vcstart', description: '🎙 افتح كول (مشرف)', staffOnly: true },
    { command: 'vcplay', description: '🎧 تشغيل أغنية بالكول' },
    { command: 'vcskip', description: '⏭ الأغنية التالية (مشرف)', staffOnly: true },
    { command: 'vcpause', description: '⏸ إيقاف مؤقت (مشرف)', staffOnly: true },
    { command: 'vcresume', description: '▶️ استئناف (مشرف)', staffOnly: true },
    { command: 'vcqueue', description: '📜 قائمة تشغيل الكول' },
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
      const status = await ctx.reply('🔎 عم دوّر…');
      const r = await callStreamer('/play', { chat_id: ctx.chat.id, query });
      if (!r?.ok) return void edit(ctx, status.message_id, errorText(r));
      const line = `<b>${r.title}</b> (${fmtDuration(r.duration)})`;
      await edit(ctx, status.message_id, r.queued ? `➕ أضيفت للطابور: ${line}\n🔢 الترتيب: ${r.position}` : `▶️ عم يشغّل الآن:\n${line}`);
    });

    // قائمة التشغيل — anyone can view.
    bot.command('vcqueue', async (ctx) => {
      if (!groupOnly(ctx) || !ctx.chat) return;
      if (!STREAMER_URL) return void ctx.reply(NOT_CONFIGURED);
      const r = await callStreamer('/queue', { chat_id: ctx.chat.id });
      if (!r?.ok) return void ctx.reply(errorText(r));
      if (!r.active) return void ctx.reply('📭 ما في شي عم يشتغل.');
      const lines = [`▶️ الآن: <b>${r.active.title}</b> (${fmtDuration(r.active.duration)})`];
      if (r.upcoming?.length) {
        lines.push('\n📜 <b>بالطابور:</b>');
        r.upcoming.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${fmtDuration(t.duration)})`));
        if (r.upcoming.length > 10) lines.push(`… و${r.upcoming.length - 10} غيرها`);
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });

    // Staff-only controls.
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
  },
};
