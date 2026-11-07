import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';
import { NOT_AVAILABLE, fmt, type Verdict } from '../../services/udplab/stats';
import { runRealUdpTest, runSimTest } from '../../services/udplab/runner';
import { saveExperiment, lastExperiment, experimentHistory, parseStored } from '../../services/udplab/store';
import type { RealUdpResult, SimUdpResult, UdpResult } from '../../services/udplab/types';

const log = createLogger('plugin:udplab');

const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const owner = (ctx: BotContext): boolean => !!ctx.from && isBotOwner(ctx.from.id);
const vIcon = (v: Verdict): string => (v === 'PASS' ? '🟢 PASS' : v === 'FAIL' ? '🔴 FAIL' : '⚪️ NOT_AVAILABLE');
const na = (v: number | typeof NOT_AVAILABLE, unit = ''): string => fmt(v, unit);

function panelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🧪 اختبار حقيقي', 'udplab:real'), Markup.button.callback('🔬 محاكاة', 'udplab:sim')],
    [Markup.button.callback('📊 آخر تقرير', 'udplab:report'), Markup.button.callback('📜 السجل', 'udplab:history')],
    [Markup.button.callback('📘 شرح علمي', 'udplab:explain')],
  ]);
}

function renderReal(r: RealUdpResult): string {
  const rtt = r.rtt === NOT_AVAILABLE ? NOT_AVAILABLE : `${r.rtt.min} / ${r.rtt.avg} / ${r.rtt.max} ms`;
  return (
    '🧪 <b>اختبار UDP حقيقي (STUN عبر الشبكة)</b>\n' +
    '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
    `<b>النتيجة:</b> ${vIcon(r.verdict)}\n` +
    `<b>الهدف:</b> <code>${esc(r.target)}</code>\n` +
    `<b>الحزم:</b> مرسلة ${r.packetsSent} · مستقبلة ${r.packetsReceived}\n` +
    `<b>الفقد (Packet Loss):</b> ${na(r.lossPct, '%')}\n` +
    `<b>PPS:</b> إرسال ${na(r.ppsSent)} · استقبال ${na(r.ppsReceived)}\n` +
    `<b>RTT (min/avg/max):</b> ${rtt}\n` +
    `<b>Jitter:</b> ${na(r.jitterMs, ' ms')}  <i>(متوسط |فرق RTT المتتالي|)</i>\n` +
    `<b>المدة:</b> ${r.durationMs} ms\n` +
    `<b>العنوان المحلي:</b> <code>${esc(r.localAddress)}</code>\n` +
    `<b>الواجهة المحلية:</b> <code>${esc(r.localInterface)}</code>\n` +
    `<b>العنوان الانعكاسي (العام):</b> <code>${esc(r.reflexiveAddress)}</code>\n` +
    `<b>البداية:</b> <code>${esc(r.startedAt)}</code>\n` +
    `<b>النهاية:</b> <code>${esc(r.endedAt)}</code>\n\n` +
    `⚠️ <i>${esc(r.note)}</i>`
  );
}

function renderSim(r: SimUdpResult): string {
  return (
    '🔬 <b>محاكاة UDP (loopback — فقد مصطنع)</b>\n' +
    '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
    `<b>النتيجة:</b> ${vIcon(r.verdict)}\n` +
    `<b>الهدف:</b> <code>${esc(r.target)}</code>\n\n` +
    '<b>① وضع طبيعي (بدون فقد):</b>\n' +
    `   مرسل ${r.baseline.sent} · مستقبل ${r.baseline.received} · فقد ${na(r.baseline.lossPct, '%')}\n` +
    `   PPS استقبال: ${na(r.baseline.ppsReceived)}\n\n` +
    `<b>② وضع فقد مصطنع (${r.artificial.injectedLossPct}%):</b>\n` +
    `   مرسل ${r.artificial.sent} · مستقبل ${r.artificial.received} · فقد ${na(r.artificial.lossPct, '%')}\n\n` +
    `<b>فرق الفقد (② − ①):</b> ${na(r.deltaLossPct, ' نقطة')}\n` +
    `<b>المدة:</b> ${r.durationMs} ms\n` +
    `<b>البداية:</b> <code>${esc(r.startedAt)}</code>\n` +
    `<b>النهاية:</b> <code>${esc(r.endedAt)}</code>\n\n` +
    `⚠️ <i>${esc(r.note)}</i>`
  );
}

function render(result: UdpResult): string {
  return result.kind === 'real' ? renderReal(result) : renderSim(result);
}

const EXPLAIN =
  '📘 <b>شرح علمي — طبقات اختبار الشبكة والصوت</b>\n' +
  '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
  '1️⃣ <b>UDP Connectivity Test</b>: هل يقدر الجهاز يرسل/يستقبل حزم UDP أصلاً؟ (نقيسه هنا بحزم فعلية).\n\n' +
  '2️⃣ <b>STUN Connectivity</b>: طلب STUN Binding يكشف إن مسار UDP لسيرفر STUN شغّال ويعطي العنوان العام (reflexive). ✋ نجاحه <b>لا</b> يعني أن كل مسارات/منافذ UDP مفتوحة، ولا يثبت الوصول لخوادم Telegram Voice.\n\n' +
  '3️⃣ <b>WebRTC Media Transport</b>: نقل الصوت الفعلي للمكالمة فوق UDP/SRTP بعد تفاوض ICE. طبقة أعلى من مجرّد connectivity.\n\n' +
  '4️⃣ <b>Packet Loss / Latency / Jitter</b>: الفقد = حزم ضاعت، Latency = زمن الرحلة (RTT)، Jitter = تذبذب هذا الزمن. كلها تؤثر على وضوح الصوت.\n\n' +
  '5️⃣ <b>UDP Flood (مفهوم أمني فقط)</b>: إغراق هدف بحزم UDP لاستنزافه — هذا <b>هجوم</b>. المختبر هنا <b>لا</b> ينفّذه: المحاكاة محدودة المعدّل وعلى loopback فقط.\n\n' +
  '🔎 <b>ملاحظة أمانة علمية:</b> مكتبة py-tgcalls / Telegram API لا توفّر قياسات فعلية لجودة المكالمة (فقد/جودة الصوت الحقيقي)، فلا نخترع هذه الأرقام ولا ندّعي أن أي اختبار «أسقط مكالمة». أي قيمة غير مقاسة تظهر كـ <code>NOT_AVAILABLE</code>.';

/** Run a test detached (so it can exceed the 30s handler window), save it, and
 *  edit the status message with the rendered result + the panel buttons. */
function runDetached(ctx: BotContext, kind: 'real' | 'sim', statusId: number, chatId: number): void {
  void (async () => {
    const result: UdpResult = kind === 'real' ? await runRealUdpTest() : await runSimTest();
    if (ctx.from) await saveExperiment(BigInt(ctx.from.id), result);
    await ctx.telegram
      .editMessageText(chatId, statusId, undefined, render(result), { parse_mode: 'HTML', ...panelKeyboard() })
      .catch(() => undefined);
  })().catch(async (err) => {
    log.error({ err, kind }, 'udp lab run failed');
    await ctx.telegram.editMessageText(chatId, statusId, undefined, '⚠️ تعذّر تشغيل الاختبار.').catch(() => undefined);
  });
}

async function startRun(ctx: BotContext, kind: 'real' | 'sim'): Promise<void> {
  if (!ctx.chat) return;
  const waiting = kind === 'real' ? '⏳ جاري تشغيل اختبار UDP حقيقي (STUN)…' : '⏳ جاري تشغيل محاكاة UDP (loopback)…';
  const sent = await ctx.reply(waiting).catch(() => undefined);
  if (!sent) return;
  runDetached(ctx, kind, sent.message_id, ctx.chat.id);
}

async function showReport(ctx: BotContext): Promise<void> {
  const row = await lastExperiment();
  if (!row) return void ctx.reply('📊 لا توجد تجارب محفوظة بعد. شغّل /udp_test أولاً.').catch(() => undefined);
  const result = parseStored(row);
  const header = `📊 <b>آخر تقرير</b> — #${row.id} · <code>${esc(row.createdAt.toISOString())}</code>\n\n`;
  const body = result ? render(result) : 'تعذّرت قراءة تفاصيل التجربة.';
  await ctx.reply(header + body, { parse_mode: 'HTML', ...panelKeyboard() }).catch(() => undefined);
}

async function showHistory(ctx: BotContext): Promise<void> {
  const rows = await experimentHistory(10);
  if (rows.length === 0) return void ctx.reply('📜 لا يوجد سجل تجارب بعد.').catch(() => undefined);
  const lines = rows.map((r) => {
    const icon = r.verdict === 'PASS' ? '🟢' : r.verdict === 'FAIL' ? '🔴' : '⚪️';
    const loss = r.lossPct === null ? NOT_AVAILABLE : `${r.lossPct}%`;
    const when = r.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    return `${icon} <b>#${r.id}</b> · ${esc(r.kind)} · ${esc(r.verdict)} · حزم ${r.packetsReceived}/${r.packetsSent} · فقد ${loss} · <code>${when}</code>`;
  });
  await ctx.reply('📜 <b>سجل تجارب UDP LAB</b> (الأحدث أولاً)\n\n' + lines.join('\n'), {
    parse_mode: 'HTML',
    ...panelKeyboard(),
  }).catch(() => undefined);
}

async function showPanel(ctx: BotContext): Promise<void> {
  const row = await lastExperiment();
  const last = row
    ? `آخر تجربة: <b>#${row.id}</b> · ${esc(row.kind)} · ${esc(row.verdict)} · <code>${esc(
        row.createdAt.toISOString().replace('T', ' ').slice(0, 19),
      )}</code>`
    : 'لا توجد تجارب محفوظة بعد.';
  const text =
    '🧰 <b>UDP LAB — لوحة المختبر</b>\n' +
    '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
    'مختبر UDP تعليمي بقياسات حقيقية. كل زر ينفّذ وظيفة فعلية:\n\n' +
    '• 🧪 <b>اختبار حقيقي</b>: حزم STUN فعلية عبر الشبكة (RTT/فقد/jitter).\n' +
    '• 🔬 <b>محاكاة</b>: على loopback فقط، بفقد مصطنع مُعلَّم.\n' +
    '• 📊 <b>آخر تقرير</b> · 📜 <b>السجل</b> · 📘 <b>شرح علمي</b>\n\n' +
    `الحالة: ${last}`;
  await ctx.reply(text, { parse_mode: 'HTML', ...panelKeyboard() }).catch(() => undefined);
}

/**
 * UDP LAB — an owner-only educational UDP measurement lab. Every command and
 * button performs a real operation; nothing is mocked. Results are persisted so
 * they can be reviewed and compared.
 */
export const udpLabPlugin: Plugin = {
  name: 'udplab',
  description: 'Owner-only educational UDP lab (real STUN measurements + safe loopback simulation)',
  commands: [
    { command: 'udp_lab', description: '🧰 لوحة مختبر UDP (مالك)', staffOnly: true },
    { command: 'udp_test', description: '🧪 تشغيل اختبار UDP حقيقي — أضف sim للمحاكاة (مالك)', staffOnly: true },
    { command: 'udp_report', description: '📊 آخر تقرير UDP (مالك)', staffOnly: true },
    { command: 'udp_history', description: '📜 سجل تجارب UDP (مالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('udp_lab', async (ctx) => {
      if (!owner(ctx)) return;
      await showPanel(ctx);
    });

    bot.command('udp_test', async (ctx) => {
      if (!owner(ctx)) return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      await startRun(ctx, arg === 'sim' || arg === 'محاكاة' ? 'sim' : 'real');
    });

    bot.command('udp_report', async (ctx) => {
      if (!owner(ctx)) return;
      await showReport(ctx);
    });

    bot.command('udp_history', async (ctx) => {
      if (!owner(ctx)) return;
      await showHistory(ctx);
    });

    bot.action(/^udplab:(real|sim|report|history|explain)$/, async (ctx) => {
      if (!owner(ctx)) return void ctx.answerCbQuery('مخصّص للمالك.', { show_alert: true }).catch(() => undefined);
      const action = ctx.match[1];
      await ctx.answerCbQuery().catch(() => undefined);
      if (action === 'real') await startRun(ctx, 'real');
      else if (action === 'sim') await startRun(ctx, 'sim');
      else if (action === 'report') await showReport(ctx);
      else if (action === 'history') await showHistory(ctx);
      else if (action === 'explain')
        await ctx.reply(EXPLAIN, { parse_mode: 'HTML', ...panelKeyboard() }).catch(() => undefined);
    });
  },
};
