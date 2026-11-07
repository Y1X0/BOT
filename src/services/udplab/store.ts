/**
 * UDP LAB — persistence. Saves each run so /udp_report (last) and /udp_history
 * can show real past results across restarts. Best-effort: a DB hiccup never
 * breaks a test (the result is still returned to the user), it just isn't saved.
 */
import { prisma } from '../../core/database';
import { createLogger } from '../../core/logger';
import { NOT_AVAILABLE } from './stats';
import type { UdpResult, RealUdpResult } from './types';

const log = createLogger('udplab:store');

const numOrNull = (v: number | typeof NOT_AVAILABLE): number | null => (v === NOT_AVAILABLE ? null : v);

export interface StoredExperiment {
  id: number;
  runBy: bigint;
  kind: string;
  target: string;
  verdict: string;
  packetsSent: number;
  packetsReceived: number;
  lossPct: number | null;
  rttAvgMs: number | null;
  jitterMs: number | null;
  durationMs: number;
  metrics: string;
  startedAt: Date;
  endedAt: Date;
  createdAt: Date;
}

/** Persist a run. Returns the new id, or null if the DB was unreachable. */
export async function saveExperiment(runBy: bigint, result: UdpResult): Promise<number | null> {
  // Row-level summary fields depend on the run kind; full detail goes in metrics.
  const sent = result.kind === 'real' ? result.packetsSent : result.baseline.sent;
  const received = result.kind === 'real' ? result.packetsReceived : result.baseline.received;
  const lossPct = result.kind === 'real' ? result.lossPct : result.baseline.lossPct;
  const rttAvg = result.kind === 'real' ? (result.rtt === NOT_AVAILABLE ? null : result.rtt.avg) : null;
  const jitter = result.kind === 'real' ? (result as RealUdpResult).jitterMs : NOT_AVAILABLE;
  try {
    const row = await prisma.udpExperiment.create({
      data: {
        runBy,
        kind: result.kind,
        target: result.target,
        verdict: result.verdict,
        packetsSent: sent,
        packetsReceived: received,
        lossPct: numOrNull(lossPct),
        rttAvgMs: rttAvg,
        jitterMs: numOrNull(jitter),
        durationMs: result.durationMs,
        metrics: JSON.stringify(result),
        startedAt: new Date(result.startedAt),
        endedAt: new Date(result.endedAt),
      },
    });
    return row.id;
  } catch (err) {
    log.warn({ err }, 'failed to save UDP experiment');
    return null;
  }
}

/** The most recent run (any owner), or null. */
export async function lastExperiment(): Promise<StoredExperiment | null> {
  try {
    return (await prisma.udpExperiment.findFirst({ orderBy: { createdAt: 'desc' } })) as StoredExperiment | null;
  } catch (err) {
    log.warn({ err }, 'failed to read last UDP experiment');
    return null;
  }
}

/** The last `limit` runs, newest first. */
export async function experimentHistory(limit = 10): Promise<StoredExperiment[]> {
  try {
    return (await prisma.udpExperiment.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(25, limit)),
    })) as StoredExperiment[];
  } catch (err) {
    log.warn({ err }, 'failed to read UDP experiment history');
    return [];
  }
}

/** Re-hydrate a stored run's full result object from its metrics JSON. */
export function parseStored(row: StoredExperiment): UdpResult | null {
  try {
    return JSON.parse(row.metrics) as UdpResult;
  } catch {
    return null;
  }
}
