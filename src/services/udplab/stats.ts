/**
 * UDP LAB — pure, dependency-free math & policy for the educational UDP lab.
 *
 * Everything here is deterministic and unit-tested (tests/udplab.test.ts). No
 * sockets, no DB, no Telegram — the network I/O lives in runner.ts. Keeping the
 * stats pure is what lets us prove the numbers are computed correctly rather
 * than asserted.
 *
 * HONESTY RULES (enforced across the lab):
 *  - A value is only ever reported as measured if it was actually measured.
 *  - Anything that could not be measured is `NOT_AVAILABLE`, never 0 or a guess.
 *  - Simulated/artificial values are labelled as such and never mixed with real.
 */

/** Marker used everywhere a value could not be genuinely measured. */
export const NOT_AVAILABLE = 'NOT_AVAILABLE' as const;
export type NotAvailable = typeof NOT_AVAILABLE;

/** A measured round-trip time, in milliseconds. */
export type RttMs = number;

export type Verdict = 'PASS' | 'FAIL' | 'NOT_AVAILABLE';

/** Round to `d` decimals (numbers only; passes NOT_AVAILABLE through). */
export function round<T extends number | NotAvailable>(v: T, d = 2): T {
  if (v === NOT_AVAILABLE) return v;
  const m = 10 ** d;
  return (Math.round((v as number) * m) / m) as T;
}

/**
 * Packet loss percentage = (sent − received) / sent × 100.
 * NOT_AVAILABLE when nothing was sent (can't divide) or inputs are invalid.
 * Clamped to [0, 100] — received can never exceed sent in a correct run, but we
 * guard against it rather than emit a negative "loss".
 */
export function packetLossPct(sent: number, received: number): number | NotAvailable {
  if (!Number.isFinite(sent) || sent <= 0 || !Number.isFinite(received) || received < 0) {
    return NOT_AVAILABLE;
  }
  const lost = Math.max(0, Math.min(sent, received <= sent ? sent - received : 0));
  return round((lost / sent) * 100);
}

/** min / avg / max of the measured RTT samples, or NOT_AVAILABLE if none. */
export function rttStats(rtts: RttMs[]): { min: number; avg: number; max: number } | NotAvailable {
  const xs = rtts.filter((r) => Number.isFinite(r) && r >= 0);
  if (xs.length === 0) return NOT_AVAILABLE;
  const sum = xs.reduce((a, b) => a + b, 0);
  return { min: round(Math.min(...xs)), avg: round(sum / xs.length), max: round(Math.max(...xs)) };
}

/**
 * Jitter (RTT variation), in ms. METHOD (documented & shown to the user):
 * the mean of the absolute differences between consecutive RTT samples,
 *   jitter = mean( |rtt[i] − rtt[i−1]| )  for i = 1..n−1.
 * This is a simple, defensible packet-delay-variation metric. It needs at least
 * two replies; with fewer it is NOT_AVAILABLE (not 0 — we didn't measure it).
 */
export function jitterMs(rtts: RttMs[]): number | NotAvailable {
  const xs = rtts.filter((r) => Number.isFinite(r) && r >= 0);
  if (xs.length < 2) return NOT_AVAILABLE;
  let sum = 0;
  for (let i = 1; i < xs.length; i++) sum += Math.abs(xs[i] - xs[i - 1]);
  return round(sum / (xs.length - 1));
}

/** Packets per second over a duration. NOT_AVAILABLE if duration is non-positive. */
export function pps(count: number, durationMs: number): number | NotAvailable {
  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return NOT_AVAILABLE;
  }
  return round((count / durationMs) * 1000, 1);
}

/**
 * PASS / FAIL / NOT_AVAILABLE for a connectivity-style run.
 *  - NOT_AVAILABLE: the run could not be carried out (no packets sent).
 *  - FAIL: packets were sent but none came back (path blocked), OR loss is
 *    above `maxLossPct`.
 *  - PASS: at least one reply and loss within the threshold.
 */
export function verdict(sent: number, received: number, maxLossPct = 20): Verdict {
  if (!Number.isFinite(sent) || sent <= 0) return 'NOT_AVAILABLE';
  if (received <= 0) return 'FAIL';
  const loss = packetLossPct(sent, received);
  if (loss === NOT_AVAILABLE) return 'NOT_AVAILABLE';
  return loss <= maxLossPct ? 'PASS' : 'FAIL';
}

// ── Simulation safety ──────────────────────────────────────────────────────
// The simulation must only ever send packets to the local machine or a private
// LAN address. It must NEVER touch a public host or Telegram. This guard is the
// single source of truth and is unit-tested.

const PRIVATE_V4 = [
  /^127\./, // loopback
  /^10\./, // private A
  /^192\.168\./, // private C
  /^169\.254\./, // link-local
  /^172\.(1[6-9]|2\d|3[0-1])\./, // private B 172.16–172.31
];

/** Is `host` a safe simulation target (loopback or private LAN only)? */
export function isSafeSimTarget(host: string): { ok: boolean; reason?: string } {
  const h = (host || '').trim().toLowerCase();
  if (!h) return { ok: false, reason: 'empty host' };
  if (h === 'localhost' || h === '::1' || h === '[::1]') return { ok: true };
  // IPv4 private ranges only.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    if (PRIVATE_V4.some((re) => re.test(h))) return { ok: true };
    return { ok: false, reason: 'public IPv4 address — simulation is restricted to loopback/LAN' };
  }
  // Anything else (public hostname, Telegram, etc.) is refused.
  return { ok: false, reason: 'only localhost / private LAN IPv4 targets are allowed' };
}

/**
 * DETERMINISTIC artificial packet drop (repeatable — no randomness).
 * METHOD (documented & shown to the user): for a target loss fraction
 *   p = injectedLossPct / 100
 * packet index `i` (0-based) is dropped iff
 *   floor((i + 1) · p) > floor(i · p).
 * This is the Bresenham/line-drawing rule: it spreads the drops out as evenly as
 * possible and makes the total dropped over `count` packets exactly
 *   floor(count · p)
 * so the realised loss is `injectedLossPct` to within a single packet, and is
 * identical on every run (unlike a random Bernoulli drop). The loss is injected
 * IN SOFTWARE inside the receiver — it is NOT real network loss.
 */
export function shouldDropDeterministic(index: number, injectedLossPct: number): boolean {
  if (!Number.isFinite(index) || index < 0) return false;
  const p = Math.max(0, Math.min(100, injectedLossPct)) / 100;
  if (p <= 0) return false;
  if (p >= 1) return true;
  return Math.floor((index + 1) * p) > Math.floor(index * p);
}

/** How many of `count` packets the deterministic rule drops = floor(count·p). */
export function expectedDrops(count: number, injectedLossPct: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const p = Math.max(0, Math.min(100, injectedLossPct)) / 100;
  return Math.floor(count * p);
}

/** A side-by-side comparison of a clean run vs a run with artificial loss. */
export interface LossComparison {
  baseline: { sent: number; received: number; lossPct: number | NotAvailable };
  artificial: {
    sent: number;
    received: number;
    lossPct: number | NotAvailable;
    injectedLossPct: number; // the loss we deliberately injected in software
  };
  /** Extra loss attributable to the injection = artificial − baseline (pts). */
  deltaLossPct: number | NotAvailable;
}

export function lossComparison(
  baseline: { sent: number; received: number },
  artificial: { sent: number; received: number; injectedLossPct: number },
): LossComparison {
  const bLoss = packetLossPct(baseline.sent, baseline.received);
  const aLoss = packetLossPct(artificial.sent, artificial.received);
  const delta =
    bLoss === NOT_AVAILABLE || aLoss === NOT_AVAILABLE ? NOT_AVAILABLE : round(aLoss - bLoss);
  return {
    baseline: { ...baseline, lossPct: bLoss },
    artificial: { ...artificial, injectedLossPct: round(artificial.injectedLossPct), lossPct: aLoss },
    deltaLossPct: delta,
  };
}

/** Format a number|NOT_AVAILABLE with an optional unit for display. */
export function fmt(v: number | NotAvailable, unit = ''): string {
  return v === NOT_AVAILABLE ? NOT_AVAILABLE : `${v}${unit}`;
}
