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
  shouldDropDeterministic,
  round,
  type NotAvailable,
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
          // A wildcard bind ("0.0.0.0" / "::") is NOT the device's real address —
          // it means "all interfaces". Never present it as the local IP.
          const wildcard = a.address === '0.0.0.0' || a.address === '::' || a.address === '::0';
          localBound = wildcard ? undefined : a.address;
          localAddress = wildcard ? NOT_AVAILABLE : `${a.address}:${a.port}`;
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
  const v = verdict(sent, received);

  // Honest, verdict-specific caveat. A missing reply is NOT proof that UDP is
  // fully blocked; a successful reply proves only this one path/server works.
  const note =
    v === 'PASS'
      ? `وصل ردّ STUN من الخادم المحدد (${host}:${port}) — مسار UDP لهذا الخادم شغّال. هذا لا يثبت أن كل مسارات/منافذ UDP مفتوحة، ولا يثبت الوصول لخوادم Telegram Voice Chat (مسارات ومنافذ مختلفة).`
      : v === 'FAIL'
        ? `لم يصل ردّ STUN من (${host}:${port}). هذا لا يثبت أن UDP محجوب بالكامل — قد يكون السبب جدار ناري لهذا المنفذ، أو مهلة قصيرة، أو خادم STUN معيّن مشغول/محجوب. للتأكد جرّب خادم/منفذ آخر.`
        : `تعذّر إجراء الاختبار (لم تُرسَل حزم). النتيجة NOT_AVAILABLE ولا يُستنتَج منها شيء عن حالة UDP.`;

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
    verdict: v,
    rttSamples,
    note,
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
    let arrived = 0; // fallback sequence counter if a payload can't be parsed
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
    rx.on('message', (msg) => {
      // Artificial, software-injected loss lives HERE and only here — and it is
      // DETERMINISTIC: keyed to each packet's sequence index (payload "udplab:i"),
      // so a given loss % reproduces EXACTLY on every run. This is NOT real
      // network loss; the packets really did travel over 127.0.0.1.
      const m = /^udplab:(\d+)$/.exec(msg.toString());
      const seq = m ? Number(m[1]) : arrived;
      arrived++;
      if (shouldDropDeterministic(seq, dropPct)) return; // "lost" (injected)
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
    note: `الفقد في وضع المحاكاة مصطنع ومحقون برمجياً داخل المستقبِل فقط (ليس فقداً حقيقياً من الشبكة). الإسقاط حتمي ومربوط برقم تسلسل كل حزمة (القاعدة: تُسقَط الحزمة i إذا كان ⌊(i+1)·p⌋ > ⌊i·p⌋ حيث p=نسبة الفقد)، فالنتيجة قابلة للتكرار بدقة (~${round(injectedLossPct)}٪) في كل تشغيل. الحزم تنتقل فعلياً عبر 127.0.0.1 ولا تغادر الجهاز.`,
  };
}

export interface NetSimOptions {
  packets?: number; // number of packets to send (default 100)
  lossPct?: number; // injected packet-loss % 0..90 (default 10)
  jitterMs?: number; // max injected jitter in ms 0..200 (default 15)
  deterministic?: boolean; // true = reproducible loss keyed to packet seq (default false = random)
}

export interface NetSimResult {
  injectedLossPct: number;
  injectedJitterMs: number;
  deterministic: boolean;
  packetsSent: number;
  packetsReceived: number;
  lossPct: number;
  outOfOrder: number;
  avgRttMs: number | NotAvailable;
  jitterStdMs: number | NotAvailable;
  jitterRfcMs: number | NotAvailable;
  durationMs: number;
}

// A lost (never-echoed) packet is detected by this per-packet timeout. On
// loopback a real round-trip is sub-millisecond, so 300ms is far more than
// enough to tell "delivered" from "dropped" — and it makes high-loss runs fast
// (at 70% loss, 1000ms wasted ~70s; 300ms cuts that to ~20s) without affecting
// the measured loss (nothing on 127.0.0.1 legitimately takes >300ms).
const NETSIM_LOST_TIMEOUT_MS = 300;

/**
 * Parametrized loopback UDP networks-lab simulation. A receiver on 127.0.0.1
 * echoes each packet back, but SIMULATES a real network: it drops a configurable
 * fraction (packet loss) and waits a random delay before echoing (jitter). The
 * sender pings sequentially and measures RTT, loss, out-of-order, and jitter in
 * two forms — the std-dev of RTT and the RFC 3550 running-mean of |ΔRTT|. Real
 * UDP packets, but they never leave the machine. Never throws.
 */
export async function runNetSim(opts: NetSimOptions = {}): Promise<NetSimResult> {
  const packets = Math.max(1, Math.min(500, Math.round(opts.packets ?? 100)));
  const lossPct = Math.max(0, Math.min(90, opts.lossPct ?? 10));
  const jitterCap = Math.max(0, Math.min(200, Math.round(opts.jitterMs ?? 15)));
  const loss = lossPct / 100;
  const deterministic = opts.deterministic ?? false;

  const t0 = performance.now();
  const rtts: number[] = [];
  let lost = 0;
  let outOfOrder = 0;
  let lastSeq = 0;

  const rx = dgram.createSocket('udp4');
  const tx = dgram.createSocket('udp4');
  // One ping in flight at a time; `settle` is the current ping's completion.
  let pending: { settle: (rtt: number | null, seq: number) => void } | null = null;
  let pendingStart = 0;

  // Receiver: echo back, but inject loss (drop) and jitter (random delay).
  // Loss is either RANDOM (Bernoulli) or DETERMINISTIC — keyed to each packet's
  // sequence number so the exact same packets drop on every run (reproducible
  // results for the report). Deterministic uses the shared Bresenham rule in
  // stats.ts; the packet's seq is carried in its payload (sent as String(seq),
  // 1-based → 0-based index here).
  rx.on('message', (msg, rinfo) => {
    let drop: boolean;
    if (deterministic) {
      const seq = Number(msg.toString()) || 0;
      drop = shouldDropDeterministic(Math.max(0, seq - 1), lossPct);
    } else {
      drop = Math.random() < loss;
    }
    if (drop) return; // "lost"
    const delay = jitterCap > 0 ? Math.random() * jitterCap : 0;
    setTimeout(() => rx.send(msg, rinfo.port, rinfo.address, () => undefined), delay);
  });
  rx.on('error', () => undefined);
  // Sender: match an echo to the pending ping.
  tx.on('message', (msg) => {
    if (!pending) return;
    const rtt = performance.now() - pendingStart;
    const seq = Number(msg.toString()) || 0;
    pending.settle(rtt, seq);
  });
  tx.on('error', () => undefined);

  const bind = (sock: dgram.Socket): Promise<number> =>
    new Promise((res) => sock.bind(0, '127.0.0.1', () => res(sock.address().port)));

  const pingOnce = (seq: number, rxPort: number): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const settle = (rtt: number | null, echoedSeq: number): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending = null;
        if (rtt !== null && rtt >= 0) {
          if (echoedSeq < lastSeq) outOfOrder++;
          lastSeq = echoedSeq;
          rtts.push(round(rtt));
        } else {
          lost++;
        }
        resolve();
      };
      const timer = setTimeout(() => settle(null, seq), NETSIM_LOST_TIMEOUT_MS);
      pending = { settle };
      pendingStart = performance.now();
      tx.send(Buffer.from(String(seq)), rxPort, '127.0.0.1', (err) => {
        if (err) settle(null, seq);
      });
    });

  try {
    const rxPort = await bind(rx);
    await bind(tx);
    for (let i = 1; i <= packets; i++) {
      await pingOnce(i, rxPort);
      if (i < packets) await sleep(20); // pacing, like the lab script
    }
  } catch {
    /* ignore — partial results still returned */
  } finally {
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
  }

  const durationMs = Math.round(performance.now() - t0);
  const received = rtts.length;
  const avg = received ? round(rtts.reduce((a, b) => a + b, 0) / received) : NOT_AVAILABLE;
  let std: number | NotAvailable = NOT_AVAILABLE;
  if (received > 1) {
    const m = rtts.reduce((a, b) => a + b, 0) / received;
    std = round(Math.sqrt(rtts.reduce((a, b) => a + (b - m) ** 2, 0) / (received - 1)));
  }
  let rfc = 0;
  for (let k = 1; k < rtts.length; k++) rfc += (Math.abs(rtts[k] - rtts[k - 1]) - rfc) / 16;
  const jitterRfc: number | NotAvailable = received > 1 ? round(rfc) : NOT_AVAILABLE;

  return {
    injectedLossPct: round(lossPct),
    injectedJitterMs: jitterCap,
    deterministic,
    packetsSent: packets,
    packetsReceived: received,
    lossPct: round(((packets - received) / packets) * 100),
    outOfOrder,
    avgRttMs: avg,
    jitterStdMs: std,
    jitterRfcMs: jitterRfc,
    durationMs,
  };
}
