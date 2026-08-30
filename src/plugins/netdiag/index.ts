import dgram from 'node:dgram';
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isBotOwner } from '../../utils/permissions';

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
