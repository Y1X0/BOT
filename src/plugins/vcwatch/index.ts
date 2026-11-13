import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:vcwatch');

// The headless streamer (music-bot/) owns the assistant USER account that sits
// inside the voice chat — the only vantage point that can enumerate call
// participants (a Bot-API bot can't call phone.getGroupParticipants).
const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

interface VcPart {
  id: number;
  name: string;
  username?: string | null;
  kind: string;
  joined_ago: number;
  active_ago: number | null;
  muted: boolean;
  ssrc: number;
  volume?: number | null;
  is_admin: boolean;
  is_assistant: boolean;
  score: number;
  reasons: string[];
}

interface VcWatchResult {
  ok: boolean;
  error?: string;
  chat_id?: number;
  count?: number;
  participants?: VcPart[];
}

/** POST to the streamer's control API. Returns the parsed body, or null when no
 *  streamer is configured. */
async function callStreamer(path: string, body: Record<string, unknown>): Promise<VcWatchResult | null> {
  if (!STREAMER_URL) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as VcWatchResult;
  } catch (err) {
    log.warn({ err, path }, 'streamer call failed');
    return { ok: false, error: 'unreachable' };
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Compact "time ago" in Arabic units. */
function ago(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}ث`;
  if (sec < 3600) return `${Math.floor(sec / 60)}د`;
  return `${Math.floor(sec / 3600)}س`;
}

const ERRORS: Record<string, string> = {
  not_member: '⚠️ الحساب المساعد مش عضو بالقروب. ضيفه أول عبر /vcjoin.',
  no_call: 'ℹ️ ما في كول شغّال حالياً بالقروب — الفحص بيشتغل وقت الكول مفتوح.',
  starting: '⏳ خدمة الكول عم تصحى، جرّب كمان شوي.',
  unreachable: '⚠️ خدمة الكول نايمة/غير متوفرة حالياً.',
  unauthorized: '⚠️ توكن خدمة الكول غير متطابق (STREAMER_TOKEN).',
  bad_request: '⚠️ طلب غير صحيح.',
  bad_response: '⚠️ ردّ غير متوقع من خدمة الكول.',
};

/** Red/orange/white/green badge from the suspicion score. */
function flag(p: VcPart): string {
  if (p.is_admin || p.is_assistant) return '🟢';
  if (p.score >= 6) return '🔴';
  if (p.score >= 4) return '🟠';
  return '⚪️';
}

function renderPart(p: VcPart): string {
  const uname = p.username ? ` @${esc(p.username)}` : '';
  const tag = p.is_admin ? ' <i>(مشرف)</i>' : p.is_assistant ? ' <i>(المساعد)</i>' : '';
  const state = p.active_ago != null && p.active_ago <= 10 ? '🎙 يبثّ الآن' : p.muted ? '🔇 مكتوم' : '🔊 مفتوح';
  const head = `${flag(p)} <b>${esc(p.name)}</b>${uname}${tag}`;
  const meta = `   🆔 <code>${p.id}</code> · انضمّ قبل ${ago(p.joined_ago)} · ${state}`;
  const why = p.reasons.length ? `\n   📌 ${esc(p.reasons.join('، '))}` : '';
  return `${head}\n${meta}${why}`;
}

export const vcwatchPlugin: Plugin = {
  name: 'vcwatch',
  description: 'Owner: identify suspicious accounts inside the group voice chat (detection only)',
  commands: [
    { command: 'vcwatch', description: '🛡 كشف الحسابات المشبوهة بالكول (مالك)', staffOnly: true },
    { command: 'vcguard', description: '🛰 حارس الكول الحيّ: تشغيل/إيقاف/كتم تلقائي (مالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command(['vcwatch', 'callwatch'], async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      if (!ctx.chat || ctx.chat.type === 'private') {
        return void ctx.reply('🛡 استخدم الأمر جوّه القروب اللي فيه الكول.');
      }
      if (!STREAMER_URL) {
        return void ctx.reply('⚠️ خدمة الكول غير مهيّأة (STREAMER_URL غير مضبوط).');
      }

      const status = await ctx.reply('🛡 عم أفحص مشاركي الكول…').catch(() => undefined);
      const statusId = (status as { message_id?: number } | undefined)?.message_id;
      const render = (text: string): Promise<unknown> =>
        statusId
          ? ctx.telegram.editMessageText(ctx.chat!.id, statusId, undefined, text, { parse_mode: 'HTML' }).catch(() => undefined)
          : ctx.reply(text, { parse_mode: 'HTML' }).catch(() => undefined);

      const r = await callStreamer('/vcwatch', { chat_id: ctx.chat.id });
      if (!r) return void render('⚠️ خدمة الكول غير مهيّأة.');
      if (!r.ok) return void render(ERRORS[r.error ?? ''] ?? `⚠️ تعذّر الفحص: ${esc(r.error ?? 'غير معروف')}`);

      const parts = r.participants ?? [];
      const others = parts.filter((p) => !p.is_assistant);
      if (!others.length) {
        return void render('✅ الكول شغّال، بس ما في مشاركين غير الحساب المساعد.');
      }

      const suspects = others.filter((p) => p.score >= 4 && !p.is_admin);
      const header =
        `🛡 <b>فحص الكول</b> — المشاركون: ${r.count ?? others.length}\n` +
        (suspects.length
          ? `🔴 <b>مشتبه بهم: ${suspects.length}</b> — انضمام فوري/بثّ نشِط\n`
          : '🟢 ما في نمط هجوم واضح هلّق.\n') +
        '━━━━━━━━━━━━━';
      // Sorted most-suspicious first by the streamer; cap so the message stays small.
      const body = others.slice(0, 15).map(renderPart).join('\n\n');
      const extra = others.length > 15 ? `\n\n… و${others.length - 15} غيرهم.` : '';
      const foot =
        '\n━━━━━━━━━━━━━\n' +
        '🔎 <b>كشف فقط</b> — ما بطرد حدا. للطرد اليدوي استخدم <code>/ban</code> أو <code>/kick</code> على الحساب (بالآيدي أو بالرد).\n' +
        '🟢 مشرف/مساعد · 🟠 مشتبه · 🔴 اشتباه عالي';
      await render(`${header}\n${body}${extra}${foot}`);
    });

    // --- Live guard: continuous background watcher on the streamer ---
    bot.command(['vcguard', 'callguard'], async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      if (!ctx.chat || ctx.chat.type === 'private') {
        return void ctx.reply('🛰 استخدم الأمر جوّه القروب اللي فيه الكول.');
      }
      if (!STREAMER_URL) {
        return void ctx.reply('⚠️ خدمة الكول غير مهيّأة (STREAMER_URL غير مضبوط).');
      }
      const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
      // on | تشغيل [mute|كتم] · off | ايقاف · status | حالة (default)
      let action: 'on' | 'off' | 'status' = 'status';
      if (['on', 'تشغيل', 'start', 'شغل'].includes(arg)) action = 'on';
      else if (['off', 'ايقاف', 'إيقاف', 'stop', 'وقف'].includes(arg)) action = 'off';
      const rest = (ctx.message.text.split(/\s+/)[2] || '').toLowerCase();
      const automute = action === 'on' && ['mute', 'كتم', 'auto', 'تلقائي'].includes(rest);

      const r = await callStreamer('/vcguard', { chat_id: ctx.chat.id, action, automute });
      if (!r) return void ctx.reply('⚠️ خدمة الكول غير مهيّأة.');
      if (!r.ok) {
        const msg = ERRORS[r.error ?? ''] ?? `⚠️ تعذّر: ${esc(r.error ?? 'غير معروف')}`;
        return void ctx.reply(msg, { parse_mode: 'HTML' });
      }
      const rr = r as unknown as { active?: boolean; automute?: boolean; already?: boolean; watching?: number };
      if (action === 'off') {
        return void ctx.reply('🛡 تم إيقاف حارس الكول.');
      }
      if (action === 'status') {
        return void ctx.reply(
          rr.active
            ? `🛰 حارس الكول: <b>شغّال</b> ${rr.automute ? '(كتم تلقائي ✅)' : '(كشف وتنبيه فقط)'}`
            : '🛡 حارس الكول: متوقّف. شغّله بـ <code>/vcguard on</code> (أو <code>/vcguard on mute</code> للكتم التلقائي).',
          { parse_mode: 'HTML' },
        );
      }
      // action === 'on'
      await ctx.reply(
        `🛰 <b>حارس الكول اشتغل</b> ${rr.already ? '(كان شغّال، حدّثت الإعداد)' : ''}\n` +
          `• الوضع: ${automute ? '🔇 كتم تلقائي للمهاجم (الكول ما بيفصل)' : '🔔 كشف وتنبيه فقط'}\n` +
          `• بيراقب كل ~1.5 ثانية وبيبلّغك أول ما يطلع حساب ببصمة الفيضان.\n` +
          (automute ? '' : '💡 للكتم التلقائي: <code>/vcguard on mute</code>\n') +
          '🛑 للإيقاف: <code>/vcguard off</code>',
        { parse_mode: 'HTML' },
      );
    });
  },
};
