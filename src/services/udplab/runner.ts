/**
 * UDP LAB — the actual network I/O (the only part that touches sockets).
 *
 * Two runs, both producing REAL packets:
 *  - runRealUdpTest: sends STUN Binding Requests to a public STUN server over
 *    UDP and measures genuine RTT / loss / jitter from the replies. This is a
 *    real round-trip over the network.
 *  - runSimTest: a self-contained loopback experiment. Real UDP packets travel
 *    over 127.0.0.1; packet loss is injected IN SOFTWARE inside the receiver and
 *    labelled as artificial. It never leaves the machine.
 *
 * Nothing here throws: every path resolves to a result (NOT_AVAILABLE on error).
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../../core/logger';
import {
  NOT_AVAILABLE,
  packetLossPct,
  rttStats,
  jitterMs,
  pps,
  verdict,
  isSafeSimTarget,
  lossComparison,
  round,
} from './stats';
import type { RealUdpResult, SimUdpResult } from './types';

const log = createLogger('udplab');

const STUN_MAGIC = 0x2112a442;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RealTestOptions {
  host?: string;
  port?: number;
  count?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Best-effort local interface (name + IPv4). NOT_AVAILABLE when ambiguous. */
function localInterface(boundAddress?: string): string {
  try {
    const ifaces = os.networkInterfaces();
    const v4: { name: string; address: string }[] = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) v4.push({ name, address: a.address });
      }
    }
    if (boundAddress && boundAddress !== '0.0.0.0') {
      const m = v4.find((i) => i.address === boundAddress);
      if (m) return `${m.name} (${m.address})`;
    }
    if (v4.length === 1) return `${v4[0].name} (${v4[0].address})`;
    return NOT_AVAILABLE;
  } catch {
    return NOT_AVAILABLE;
  }
}

/** Parse the reflexive (public) address from a STUN success response, or null.
 *  Handles XOR-MAPPED-ADDRESS (0x0020) and falls back to MAPPED-ADDRESS (0x0001). */
function parseReflexive(msg: Buffer): string | null {
  try {
    if (msg.length < 20) return null;
    let off = 20; // skip 20-byte header
    while (off + 4 <= msg.length) {
      const type = msg.readUInt16BE(off);
      const len = msg.readUInt16BE(off + 2);
      const val = off + 4;
      if (val + len > msg.length) break;
      if (type === 0x0020 || type === 0x0001) {
        const family = msg.readUInt8(val + 1);
        if (family === 0x01) {
          let port = msg.readUInt16BE(val + 2);
          const ipBuf = Buffer.from(msg.subarray(val + 4, val + 8));
          if (type === 0x0020) {
            port ^= STUN_MAGIC >>> 16;
            for (let i = 0; i < 4; i++) ipBuf[i] ^= (STUN_MAGIC >>> (24 - 8 * i)) & 0xff;
          }
          return `${ipBuf[0]}.${ipBuf[1]}.${ipBuf[2]}.${ipBuf[3]}:${port & 0xffff}`;
        }
      }
      off = val + len + ((4 - (len % 4)) % 4); // 4-byte aligned
    }
  } catch {
    /* malformed — treat as no reflexive address */
  }
  return null;
}

/**
 * Real UDP test: ping a STUN server `count` times, measuring per-packet RTT and
 * counting replies. Sequential (ping-style) so each RTT is attributable.
 */
export async function runRealUdpTest(opts: RealTestOptions = {}): Promise<RealUdpResult> {
  const host = opts.host ?? 'stun.l.google.com';
  const port = opts.port ?? 19302;
  const count = Math.max(1, Math.min(100, opts.count ?? 20));
  const intervalMs = Math.max(20, Math.min(1000, opts.intervalMs ?? 150));
  const timeoutMs = Math.max(200, Math.min(5000, opts.timeoutMs ?? 1200));

  const startedAt = new Date();
  const rttSamples: number[] = [];
  let sent = 0;
  let reflexive: string | null = null;
  let localAddress: string = NOT_AVAILABLE;
  let localBound: string | undefined;

  const sock = dgram.createSocket('udp4');
  // One pending ping at a time; the message handler matches by transaction id.
  let pending: { txid: string; settle: (rtt: number | null) => void } | null = null;
  let pendingT0 = 0;

  sock.on('message', (msg) => {
    if (!pending) return;
    if (msg.length < 20) return;
    const txid = msg.subarray(8, 20).toString('hex');
    if (txid !== pending.txid) return; // not our current ping
    const rtt = performance.now() - pendingT0;
    if (reflexive === null) reflexive = parseReflexive(msg);
    pending.settle(rtt);
  });
  sock.on('error', (err) => {
    if (pending) pending.settle(null);
    log.warn({ err }, 'udp real test socket error');
  });

  const pingOnce = (): Promise<void> =>
    new Promise((resolve) => {
      const txidBuf = Buffer.alloc(12);
      for (let i = 0; i < 12; i++) txidBuf[i] = Math.floor(Math.random() * 256);
      const txid = txidBuf.toString('hex');
      const req = Buffer.concat([
        Buffer.from([0x00, 0x01, 0x00, 0x00]), // type=Binding Request, length=0
        Buffer.from([0x21, 0x12, 0xa4, 0x42]), // magic cookie
        txidBuf,
      ]);
      let settled = false;
      const settle = (rtt: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending = null;
        if (rtt !== null && rtt >= 0) rttSamples.push(round(rtt));
        resolve();
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      pending = { txid, settle };
      pendingT0 = performance.now();
      sent++;
      sock.send(req, port, host, (err) => {
        if (err) settle(null); // send failed → counts as a lost packet
      });
    });

  try {
    for (let i = 0; i < count; i++) {
      await pingOnce();
      if (i === 0) {
        try {
          const a = sock.address();
          localBound = a.address;
          localAddress = `${a.address}:${a.port}`;
        } catch {
          /* leave NOT_AVAILABLE */
        }
      }
      if (i < count - 1) await sleep(intervalMs);
    }
  } finally {
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  }

  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const received = rttSamples.length;

  return {
    kind: 'real',
    target: `${host}:${port}`,
    packetsSent: sent,
    packetsReceived: received,
    lossPct: packetLossPct(sent, received),
    rtt: rttStats(rttSamples),
    jitterMs: jitterMs(rttSamples),
    ppsSent: pps(sent, durationMs),
    ppsReceived: pps(received, durationMs),
    localAddress,
    localInterface: localInterface(localBound),
    reflexiveAddress: reflexive ?? NOT_AVAILABLE,
    durationMs,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    verdict: verdict(sent, received),
    rttSamples,
    note:
      'STUN نجح يعني مسار UDP لهذا السيرفر شغّال فقط. لا يثبت أن كل مسارات UDP مفتوحة، ولا يثبت الوصول لخوادم Telegram Voice Chat (مسارات/منافذ مختلفة).',
  };
}

export interface SimTestOptions {
  count?: number;
  intervalMs?: number;
  injectedLossPct?: number;
  target?: string; // must be loopback/LAN; defaults to 127.0.0.1
}

/** One loopback run: send `count` packets to a local receiver; the receiver
 *  drops ~`dropPct`% in software. Returns the real sent/received counts. */
function loopbackRun(count: number, intervalMs: number, dropPct: number): Promise<{ sent: number; received: number }> {
  return new Promise((resolve) => {
    const rx = dgram.createSocket('udp4');
    let received = 0;
    let sent = 0;
    let done = false;
    const finishAll = (): void => {
      if (done) return;
      done = true;
      try {
        rx.close();
      } catch {
        /* ignore */
      }
      try {
        tx.close();
      } catch {
        /* ignore */
      }
      resolve({ sent, received });
    };
    rx.on('message', () => {
      // Artificial, software-injected loss lives HERE and only here.
      if (Math.random() * 100 < dropPct) return; // "lost"
      received++;
    });
    rx.on('error', () => finishAll());
    const tx = dgram.createSocket('udp4');
    tx.on('error', () => finishAll());

    rx.bind(0, '127.0.0.1', () => {
      const port = rx.address().port;
      let i = 0;
      const tick = (): void => {
        if (i >= count) {
          // Let the last packets drain, then finish.
          setTimeout(finishAll, 300);
          return;
        }
        const payload = Buffer.from(`udplab:${i}`);
        tx.send(payload, port, '127.0.0.1', (err) => {
          if (!err) sent++;
        });
        i++;
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  });
}

/**
 * Safe loopback simulation: a clean baseline run vs a run with artificial,
 * software-injected packet loss, so the effect of loss can be compared with
 * real packets but without ever touching the network.
 */
export async function runSimTest(opts: SimTestOptions = {}): Promise<SimUdpResult> {
  const target = (opts.target ?? '127.0.0.1').trim();
  const count = Math.max(10, Math.min(2000, opts.count ?? 300));
  const intervalMs = Math.max(1, Math.min(50, opts.intervalMs ?? 3));
  const injectedLossPct = Math.max(0, Math.min(90, opts.injectedLossPct ?? 25));

  const startedAt = new Date();
  const safe = isSafeSimTarget(target);
  if (!safe.ok) {
    const endedAt = new Date();
    return {
      kind: 'sim',
      target,
      baseline: { sent: 0, received: 0, lossPct: NOT_AVAILABLE, ppsReceived: NOT_AVAILABLE },
      artificial: { sent: 0, received: 0, lossPct: NOT_AVAILABLE, injectedLossPct },
      deltaLossPct: NOT_AVAILABLE,
      durationMs: endedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      verdict: 'NOT_AVAILABLE',
      note: `رُفض الهدف "${target}": ${safe.reason}. المحاكاة مسموحة فقط على loopback/LAN خاصة.`,
    };
  }

  // Baseline (no artificial loss), then the artificial-loss run. Both real
  // loopback packets; the only difference is the software drop in the receiver.
  const baseline = await loopbackRun(count, intervalMs, 0).catch(() => ({ sent: 0, received: 0 }));
  const artificial = await loopbackRun(count, intervalMs, injectedLossPct).catch(() => ({ sent: 0, received: 0 }));

  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const cmp = lossComparison(baseline, { ...artificial, injectedLossPct });

  return {
    kind: 'sim',
    target: `${target} (loopback)`,
    baseline: {
      sent: baseline.sent,
      received: baseline.received,
      lossPct: cmp.baseline.lossPct,
      ppsReceived: pps(baseline.received, Math.max(1, count * intervalMs)),
    },
    artificial: {
      sent: artificial.sent,
      received: artificial.received,
      lossPct: cmp.artificial.lossPct,
      injectedLossPct: round(injectedLossPct),
    },
    deltaLossPct: cmp.deltaLossPct,
    durationMs,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    // PASS = the clean baseline actually delivered its packets over loopback.
    verdict: verdict(baseline.sent, baseline.received, 5),
    note: 'الفقد في وضع المحاكاة مصطنع ومحقون برمجياً داخل المستقبِل فقط (ليس فقداً حقيقياً من الشبكة). الحزم تنتقل فعلياً عبر 127.0.0.1 ولا تغادر الجهاز.',
  };
}
