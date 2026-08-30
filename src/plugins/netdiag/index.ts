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

  register(bot: Telegraf<BotContext>) {
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
