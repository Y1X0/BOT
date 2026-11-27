import dgram from 'node:dgram';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';
import { prisma } from '../../core/database';

/** Verdict emoji from a value against (good, ok) thresholds — lower is better. */
function grade(ms: number, good: number, ok: number): string {
  return ms <= good ? '🟢' : ms <= ok ? '🟡' : '🔴';
}

/** Time an async fn in ms (rounded). */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  try {
    await fn();
  } catch {
    return -1;
  }
  return Math.round(performance.now() - t0);
}

interface SpeedReport {
  dbPingMin: number;
  dbPingAvg: number;
  dbRead: number;
  tgApi: number;
  cpuMs: number;
  loopLag: number;
}

/** Measure where time actually goes: DB round-trip, Telegram API, CPU, loop lag. */
async function measureSpeed(ctx: BotContext): Promise<SpeedReport> {
  // DB round-trip: pure network+DB latency (SELECT 1), a few times for stability.
  const pings: number[] = [];
  for (let i = 0; i < 3; i++) {
    pings.push(await timed(() => prisma.$queryRaw`SELECT 1`));
  }
  const ok = pings.filter((p) => p >= 0);
  const dbPingMin = ok.length ? Math.min(...ok) : -1;
  const dbPingAvg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : -1;

  // A real indexed read (settings for THIS chat, or any light lookup).
  const chatId = ctx.chat?.id;
  const dbRead = await timed(() =>
    chatId
      ? prisma.chatSettings.findUnique({ where: { chatId: BigInt(chatId) } })
      : prisma.globalConfig.findFirst(),
  );

  // Telegram API round-trip (getMe is a cheap authenticated call).
  const tgApi = await timed(() => ctx.telegram.getMe());

  // CPU: a fixed compute burst. Fast box ~10-30ms; a starved shared CPU ≫100ms.
  const c0 = performance.now();
  let x = 0;
  for (let i = 0; i < 5_000_000; i++) x += Math.sqrt(i);
  const cpuMs = Math.round(performance.now() - c0);
  if (x < 0) throw new Error('unreachable'); // keep the loop from being optimized away

  // Event-loop lag: how late an immediate timer fires (delay = contention).
  const l0 = performance.now();
  await new Promise((r) => setTimeout(r, 0));
  const loopLag = Math.round(performance.now() - l0);

  return { dbPingMin, dbPingAvg, dbRead, tgApi, cpuMs, loopLag };
}

function renderSpeed(r: SpeedReport): string {
  const line = (label: string, ms: number, good: number, ok: number, hint: string): string =>
    ms < 0 ? `${label}: ❌ فشل` : `${grade(ms, good, ok)} ${label}: <b>${ms}ms</b>${hint}`;

  const verdicts: string[] = [];
  if (r.dbPingMin > 80) verdicts.push('🔴 <b>القاعدة بعيدة</b> — منطقة Neon غالباً بأمريكا وRender بأوروبا. انقل Neon لمنطقة أوروبا (EU) وبتصير كل رسالة أسرع بكثير.');
  else if (r.dbPingMin >= 0 && r.dbPingMin <= 25) verdicts.push('🟢 القاعدة قريبة وسريعة.');
  if (r.cpuMs > 120 || r.loopLag > 60) verdicts.push('🔴 <b>المعالج ضعيف / مزدحم</b> — نموذجي لـ Render المجّاني. الحل الجذري: سيرفر أقوى (Oracle مجاني أو VPS رخيص).');
  else if (r.cpuMs <= 40 && r.loopLag <= 15) verdicts.push('🟢 المعالج بحالة جيدة.');
  if (r.tgApi > 400) verdicts.push('🟡 تأخير تيليجرام مرتفع — عادةً الشبكة/المنطقة.');

  return (
    '⚡️ <b>فحص سرعة البوت</b>\n\n' +
    line('تأخير القاعدة (أدنى)', r.dbPingMin, 25, 80, r.dbPingMin > 80 ? ' ← المشكلة هون غالباً' : '') + '\n' +
    `   <i>المتوسط: ${r.dbPingAvg < 0 ? '—' : r.dbPingAvg + 'ms'}</i>\n` +
    line('قراءة إعدادات', r.dbRead, 40, 120, '') + '\n' +
    line('تأخير تيليجرام', r.tgApi, 200, 400, '') + '\n' +
    line('حساب المعالج', r.cpuMs, 40, 120, '') + '\n' +
    line('ازدحام الحلقة', r.loopLag, 15, 60, '') + '\n\n' +
    '<b>الخلاصة:</b>\n' + (verdicts.length ? verdicts.join('\n') : 'الأرقام ضمن الطبيعي.')
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RttStats {
  samples: number;
  success: number;
  failed: number;
  min: number;
  avg: number;
  max: number;
  jitterStd: number;
  jitterRfc: number;
}

/**
 * Real Bot-API RTT between this Render container and Telegram's servers, sampled
 * over repeated lightweight getMe calls. Gives min/avg/max plus jitter (std-dev
 * and RFC 3550). This is a genuine network round-trip — nothing simulated.
 */
async function measureTelegramRtt(
  ctx: BotContext,
  samples = 10,
  intervalMs = 200,
): Promise<RttStats> {
  const rtts: number[] = [];
  let failed = 0;
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      await ctx.telegram.getMe();
      rtts.push(performance.now() - t0);
    } catch {
      failed++;
    }
    if (i < samples - 1) await sleep(intervalMs);
  }
  const n = rtts.length;
  const avg = n ? rtts.reduce((a, b) => a + b, 0) / n : 0;
  const min = n ? Math.min(...rtts) : 0;
  const max = n ? Math.max(...rtts) : 0;
  let std = 0;
  if (n > 1) std = Math.sqrt(rtts.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1));
  let rfc = 0;
  for (let k = 1; k < n; k++) rfc += (Math.abs(rtts[k] - rtts[k - 1]) - rfc) / 16;
  const r = (x: number): number => Math.round(x * 100) / 100;
  return { samples, success: n, failed, min: r(min), avg: r(avg), max: r(max), jitterStd: r(std), jitterRfc: r(rfc) };
}

/** Event-loop lag of the bot process: how much later an immediate timer fires
 *  than scheduled. High lag = CPU pressure / blocking work on the host. */
async function measureLoopLag(durationMs = 2000, stepMs = 50): Promise<{ avg: number; max: number }> {
  const lags: number[] = [];
  const steps = Math.max(1, Math.floor(durationMs / stepMs));
  for (let i = 0; i < steps; i++) {
    const expected = performance.now() + stepMs;
    await sleep(stepMs);
    lags.push(Math.max(0, performance.now() - expected));
  }
  const avg = lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0;
  const max = lags.length ? Math.max(...lags) : 0;
  return { avg: Math.round(avg * 100) / 100, max: Math.round(max * 100) / 100 };
}

/** Honest diagnostics report: real measured values from the bot, and an explicit
 *  NOT_AVAILABLE for call-layer metrics the stack/host cannot expose. */
function renderNetcheck(rtt: RttStats, loop: { avg: number; max: number }): string {
  return (
    '📊 <b>فحص الشبكة والاتصال من البوت (Render)</b>\n' +
    '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
    '<b>1) زمن الاستجابة لخوادم تيليجرام (Bot-API RTT):</b>\n' +
    `• ناجح: <code>${rtt.success}/${rtt.samples}</code> · فشل: <code>${rtt.failed}</code>\n` +
    `• RTT (أدنى/متوسط/أقصى): <code>${rtt.min} / ${rtt.avg} / ${rtt.max} ms</code>\n` +
    `• Jitter (StdDev / RFC 3550): <code>${rtt.jitterStd} / ${rtt.jitterRfc} ms</code>\n\n` +
    '<b>2) استقرار عملية البوت (Event Loop):</b>\n' +
    `• متوسط التأخر: <code>${loop.avg} ms</code> · أقصى تأخر: <code>${loop.max} ms</code>\n\n` +
    '<b>3) مقاييس المكالمة (SRTP/RTP):</b>\n' +
    '• بث المساعد الصوتي: <code>يُقاس على المساعد عند تشغيله فقط</code>\n' +
    '• فقد حزم المكالمة (Packet Loss): <code>NOT_AVAILABLE</code> <i>(غير مكشوف في py-tgcalls/ntgcalls)</i>\n' +
    '• معدل نقل الصوت (SRTP Bitrate): <code>NOT_AVAILABLE</code> <i>(يحتاج التقاط حزم خارج الحاوية)</i>\n\n' +
    '✅ <i>كل القيم أعلاه مقيسة فعلياً من البوت؛ والمحجوب يظهر صراحةً NOT_AVAILABLE.</i>'
  );
}

/**
 * Send a STUN binding request over UDP to a public STUN server and wait for a
 * reply. WebRTC (the voice-chat streamer) needs outbound UDP, so this reveals
 * whether the current host allows it — many free PaaS (Render, etc.) don't.
 */
function testUdp(host = 'stun.l.google.com', port = 19302, timeoutMs = 5000): Promise<{ ok: boolean; detail: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = dgram.createSocket('udp4');
    // Minimal STUN Binding Request: type 0x0001, length 0, magic cookie, 12-byte txid.
    const req = Buffer.from('000100002112a442' + '0'.repeat(24), 'hex');
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve({ ok, detail, ms: Date.now() - started });
    };
    sock.on('message', (msg, rinfo) => finish(true, `رد من ${rinfo.address}:${rinfo.port} (${msg.length} بايت)`));
    sock.on('error', (err) => finish(false, err.message));
    sock.send(req, port, host, (err) => {
      if (err) finish(false, `تعذّر الإرسال: ${err.message}`);
    });
    setTimeout(() => finish(false, `لا رد خلال ${timeoutMs / 1000} ثواني — UDP محجوب`), timeoutMs);
  });
}

/** Owner-only network diagnostics — currently a UDP/WebRTC reachability probe. */
export const netdiagPlugin: Plugin = {
  name: 'netdiag',
  description: 'Owner network diagnostics (UDP/WebRTC probe)',
  commands: [
    { command: 'netcheck', description: '📊 فحص شبكة البوت: RTT/Jitter/Loop (مالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command(['netcheck', 'netstat'], async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const msg = await ctx.reply('⏳ جاري قياس RTT واستقرار البوت من Render…').catch(() => undefined);
      const [rtt, loop] = await Promise.all([measureTelegramRtt(ctx, 10, 200), measureLoopLag(2000, 50)]);
      const text = renderNetcheck(rtt, loop);
      const id = (msg as { message_id?: number } | undefined)?.message_id;
      if (id && ctx.chat)
        await ctx.telegram.editMessageText(ctx.chat.id, id, undefined, text, { parse_mode: 'HTML' }).catch(() => undefined);
      else await ctx.reply(text, { parse_mode: 'HTML' }).catch(() => undefined);
    });

    bot.command(['speed', 'speedtest', 'ping'], async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const msg = await ctx.reply('⏱ جاري قياس السرعة...').catch(() => undefined);
      const report = await measureSpeed(ctx);
      const text = renderSpeed(report);
      const id = (msg as { message_id?: number } | undefined)?.message_id;
      if (id && ctx.chat) await ctx.telegram.editMessageText(ctx.chat.id, id, undefined, text, { parse_mode: 'HTML' }).catch(() => undefined);
      else await ctx.reply(text, { parse_mode: 'HTML' }).catch(() => undefined);
    });

    bot.command(['udptest', 'udbtest'], async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const msg = await ctx.reply('🔎 جاري فحص UDP (اللازم للكول/WebRTC)...').catch(() => undefined);
      const r = await testUdp();
      const text = r.ok
        ? `✅ <b>UDP يعمل على هذا السيرفر</b>\n🎧 الكول (voice chat) ممكن يشتغل هنا.\n• ${r.detail}\n• الزمن: ${r.ms}ms`
        : `❌ <b>UDP محجوب على هذا السيرفر</b>\n🎧 الكول <b>لن يعمل</b> هنا — بحتاج سيرفر يدعم UDP (VPS/جهازك).\n• ${r.detail}`;
      const id = (msg as { message_id?: number } | undefined)?.message_id;
      if (id && ctx.chat) await ctx.telegram.editMessageText(ctx.chat.id, id, undefined, text, { parse_mode: 'HTML' }).catch(() => undefined);
      else await ctx.reply(text, { parse_mode: 'HTML' }).catch(() => undefined);
    });
  },
};
