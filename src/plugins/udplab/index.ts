import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';
import { NOT_AVAILABLE, fmt, type Verdict } from '../../services/udplab/stats';
import { runRealUdpTest, runSimTest, runNetSim, type NetSimResult } from '../../services/udplab/runner';
import { saveExperiment, lastExperiment, experimentHistory, parseStored } from '../../services/udplab/store';
import type { RealUdpResult, SimUdpResult, UdpResult } from '../../services/udplab/types';

const log = createLogger('plugin:udplab');

// Streamer (assistant) health probe — used by /udp_full's Call-Lab stage to
// report HONESTLY whether the assistant is online, without ever fabricating the
// (unavailable) media-path metrics.
const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');

async function checkCallLab(): Promise<{ online: boolean; detail: string }> {
  if (!STREAMER_URL) return { online: false, detail: 'خدمة المساعد غير مهيّأة (STREAMER_URL)' };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const res = await fetch(`${STREAMER_URL}/health`, { signal: c.signal }).finally(() => clearTimeout(t));
    if (res.ok) return { online: true, detail: 'المساعد متصل' };
    return { online: false, detail: `المساعد غير جاهز (health ${res.status})` };
  } catch {
    return { online: false, detail: 'المساعد غير مستجيب (موقوف/نائم)' };
  }
}

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

/** Render the parametrized networks-lab simulation (loss + jitter). */
function renderNetSim(r: NetSimResult): string {
  return (
    '🔬 <b>محاكاة أداء UDP (مختبر الشبكات)</b>\n' +
    '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
    `<b>الإعداد:</b> فقد ${r.injectedLossPct}% · اهتزاز ≤ ${r.injectedJitterMs}ms · ${r.packetsSent} حزمة · ` +
    `الوضع: ${r.deterministic ? '🎯 حتمي (قابل للتكرار)' : '🎲 عشوائي'}\n` +
    '┈┈┈┈┈┈┈┈┈┈\n' +
    `<b>Total Sent Packets</b>     : ${r.packetsSent}\n` +
    `<b>Received Packets</b>       : ${r.packetsReceived}\n` +
    `<b>Packet Loss Rate</b>       : ${na(r.lossPct, '%')}\n` +
    `<b>Out-of-order Packets</b>   : ${r.outOfOrder}\n` +
    `<b>Average RTT</b>            : ${na(r.avgRttMs, ' ms')}\n` +
    `<b>Jitter (Std Deviation)</b> : ${na(r.jitterStdMs, ' ms')}\n` +
    `<b>Jitter (RFC 3550)</b>      : ${na(r.jitterRfcMs, ' ms')}\n` +
    `<b>المدة</b>                  : ${r.durationMs} ms\n\n` +
    '⚠️ <i>الفقد والاهتزاز مُحقَّنان برمجياً داخل المستقبِل (ليسا من الشبكة). الحزم حقيقية لكن تنتقل عبر 127.0.0.1 ولا تغادر الجهاز.</i>'
  );
}

/**
 * Unified report for /udp_full. Three honest stages, each clearly labelled as to
 * what it actually measures:
 *   ① Controlled simulation (loopback, software-injected loss/jitter)
 *   ② Real network UDP test (actual STUN packets over the wire)
 *   ③ Call-lab status (assistant online? — media-path metrics stay NOT_AVAILABLE)
 * No audio/call quality number is ever fabricated: the media path is unmeasurable
 * from here, so it is reported as NOT_AVAILABLE, not guessed.
 */
function renderFull(sim: NetSimResult, real: RealUdpResult, call: { online: boolean; detail: string }): string {
  const realRtt = real.rtt === NOT_AVAILABLE ? NOT_AVAILABLE : `${real.rtt.min} / ${real.rtt.avg} / ${real.rtt.max} ms`;
  const delivery = sim.packetsSent > 0 ? `${Math.round((sim.packetsReceived / sim.packetsSent) * 1000) / 10}%` : NOT_AVAILABLE;

  const callBlock = call.online
    ? `<b>المساعد:</b> 🟢 متصل\n` +
      `<b>Real Media UDP Loss:</b> <code>NOT_AVAILABLE</code>\n` +
      `<b>SRTP Bitrate:</b> <code>NOT_AVAILABLE</code>\n` +
      `<i>مقاييس مسار الصوت تُقاس فقط داخل كول مفتوح عبر /call_lab؛ py-tgcalls لا يكشف فقد/معدّل الصوت الوارد.</i>`
    : `<b>الحالة:</b> <code>NOT_AVAILABLE</code> — ${esc(call.detail)}\n` +
      `<i>(المساعد غير نشط أو لا يوجد كول مفتوح — لا مقاييس مسار صوت.)</i>`;

  return (
    '🧪📡 <b>UDP FULL — تقرير موحّد (3 مراحل)</b>\n' +
    '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n\n' +
    '① <b>محاكاة متحكَّم بها (loopback)</b>\n' +
    `<b>الوضع:</b> ${sim.deterministic ? '🎯 حتمي (قابل للتكرار)' : '🎲 عشوائي'}\n` +
    `<b>الفقد المحقون:</b> ${sim.injectedLossPct}% · <b>اهتزاز ≤</b> ${sim.injectedJitterMs}ms\n` +
    `<b>الحزم:</b> مرسلة ${sim.packetsSent} · مستقبلة ${sim.packetsReceived}\n` +
    `<b>الفقد المقاس:</b> ${na(sim.lossPct, '%')} · <b>نسبة التسليم:</b> ${delivery}\n` +
    `<b>خارج الترتيب:</b> ${sim.outOfOrder}\n` +
    `<b>RTT متوسط:</b> ${na(sim.avgRttMs, ' ms')}\n` +
    `<b>Jitter (StdDev / RFC3550):</b> ${na(sim.jitterStdMs, ' ms')} / ${na(sim.jitterRfcMs, ' ms')}\n` +
    `<b>المدة:</b> ${sim.durationMs} ms\n` +
    '┈┈┈┈┈┈┈┈┈┈\n\n' +
    '② <b>اختبار UDP حقيقي (STUN عبر الشبكة)</b>\n' +
    `<b>النتيجة:</b> ${vIcon(real.verdict)}\n` +
    `<b>الهدف:</b> <code>${esc(real.target)}</code>\n` +
    `<b>الحزم:</b> مرسلة ${real.packetsSent} · مستقبلة ${real.packetsReceived}\n` +
    `<b>الفقد:</b> ${na(real.lossPct, '%')}\n` +
    `<b>RTT (min/avg/max):</b> ${realRtt}\n` +
    `<b>Jitter:</b> ${na(real.jitterMs, ' ms')}\n` +
    `<b>العنوان الانعكاسي:</b> <code>${esc(real.reflexiveAddress)}</code>\n` +
    '┈┈┈┈┈┈┈┈┈┈\n\n' +
    '③ <b>مختبر المكالمة (Call Lab)</b>\n' +
    callBlock +
    '\n\n⚠️ <i>المرحلة ① فقد/اهتزاز مُحقَّن برمجياً على 127.0.0.1 (لا يغادر الجهاز). المرحلة ② حزم حقيقية عبر الشبكة. المرحلة ③ لا تُختلق فيها أرقام صوت أبداً.</i>'
  );
}

/** Parse "/udp_sim [loss%] [jitterMs] [packets] [--det]" → options. The numeric
 *  args are positional (in order); the deterministic flag may appear anywhere
 *  (--det / --deterministic / det / حتمي). */
function parseSimArgs(text: string): { lossPct?: number; jitterMs?: number; packets?: number; deterministic?: boolean } {
  const tokens = text.split(/\s+/).slice(1);
  const deterministic = tokens.some((t) => /^(--?det(erministic)?|حتمي)$/i.test(t));
  const nums = tokens.filter((t) => /^\d+(\.\d+)?$/.test(t)).map(Number);
  return { lossPct: nums[0], jitterMs: nums[1], packets: nums[2], deterministic };
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

// Shown when the test ran fine but its result could not be persisted (e.g. the
// DB was briefly unreachable). The measurement is still valid and displayed; we
// only warn that it won't appear in /udp_report or /udp_history.
const NOT_SAVED_NOTICE =
  '\n\n⚠️ <i>اكتمل الاختبار وقيمه حقيقية، لكن تعذّر حفظه في قاعدة البيانات (قد تكون غير متصلة مؤقتاً). لن يظهر في /udp_report أو /udp_history.</i>';

/** Run a test, persist it, and render it into the status message. Exported for
 *  tests. If saving fails (saveExperiment → null) a clear notice is appended;
 *  on success the message is exactly the rendered result (unchanged). */
export async function executeRun(
  ctx: BotContext,
  kind: 'real' | 'sim',
  statusId: number,
  chatId: number,
): Promise<void> {
  const result: UdpResult = kind === 'real' ? await runRealUdpTest() : await runSimTest();
  // Only treat it as "not saved" when a save was actually attempted (ctx.from
  // present — always true on the owner-gated path) and it returned null.
  const saved = ctx.from ? await saveExperiment(BigInt(ctx.from.id), result) : null;
  const suffix = ctx.from && saved === null ? NOT_SAVED_NOTICE : '';
  await ctx.telegram
    .editMessageText(chatId, statusId, undefined, render(result) + suffix, { parse_mode: 'HTML', ...panelKeyboard() })
    .catch(() => undefined);
}

/** Run a test detached (so it can exceed the 30s handler window), save it, and
 *  edit the status message with the rendered result + the panel buttons. */
function runDetached(ctx: BotContext, kind: 'real' | 'sim', statusId: number, chatId: number): void {
  void executeRun(ctx, kind, statusId, chatId).catch(async (err) => {
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
    { command: 'udp_sim', description: '🔬 محاكاة فقد UDP: /udp_sim [فقد%] [اهتزاز] [حزم] [--det] (مالك)', staffOnly: true },
    { command: 'udp_full', description: '🧪📡 تقرير UDP موحّد (محاكاة + STUN حقيقي + حالة الكول) (مالك)', staffOnly: true },
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

    bot.command('udp_sim', async (ctx) => {
      if (!owner(ctx)) return;
      if (!ctx.chat) return;
      const opts = parseSimArgs(ctx.message.text);
      const sent = await ctx
        .reply('⏳ جاري تشغيل محاكاة أداء UDP (loopback)…')
        .catch(() => undefined);
      if (!sent) return;
      const chatId = ctx.chat.id;
      void runNetSim(opts)
        .then((r) =>
          ctx.telegram
            .editMessageText(chatId, sent.message_id, undefined, renderNetSim(r), {
              parse_mode: 'HTML',
              ...panelKeyboard(),
            })
            .catch(() => undefined),
        )
        .catch(async (err) => {
          log.error({ err }, 'udp sim failed');
          await ctx.telegram
            .editMessageText(chatId, sent.message_id, undefined, '⚠️ تعذّر تشغيل المحاكاة.')
            .catch(() => undefined);
        });
    });

    bot.command('udp_full', async (ctx) => {
      if (!owner(ctx)) return;
      if (!ctx.chat) return;
      const a = parseSimArgs(ctx.message.text);
      // /udp_full defaults to deterministic (reproducible for the report); pass
      // --rand / عشوائي to force random Bernoulli loss instead.
      const random = /(^|\s)(--?rand(om)?|عشوائي)(\s|$)/i.test(ctx.message.text);
      const opts = {
        lossPct: a.lossPct ?? 25,
        jitterMs: a.jitterMs ?? 30,
        packets: a.packets ?? 100,
        deterministic: !random,
      };
      const sent = await ctx.reply('⏳ <b>UDP FULL</b> — المرحلة 1/3: محاكاة مُتحكَّم بها…', { parse_mode: 'HTML' }).catch(() => undefined);
      if (!sent) return;
      const chatId = ctx.chat.id;
      const edit = (t: string): Promise<unknown> =>
        ctx.telegram.editMessageText(chatId, sent.message_id, undefined, t, { parse_mode: 'HTML' }).catch(() => undefined);
      void (async () => {
        try {
          const sim = await runNetSim(opts);
          await edit('⏳ <b>UDP FULL</b> — المرحلة 2/3: اختبار UDP حقيقي (STUN)…');
          const real = await runRealUdpTest();
          await edit('⏳ <b>UDP FULL</b> — المرحلة 3/3: فحص حالة مختبر المكالمة…');
          const call = await checkCallLab();
          await ctx.telegram
            .editMessageText(chatId, sent.message_id, undefined, renderFull(sim, real, call), {
              parse_mode: 'HTML',
              ...panelKeyboard(),
            })
            .catch(() => undefined);
        } catch (err) {
          log.error({ err }, 'udp full failed');
          await edit('⚠️ تعذّر تشغيل /udp_full.');
        }
      })();
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
