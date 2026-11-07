import type { NotAvailable, Verdict } from './stats';

/** Result of a REAL UDP test: genuine STUN binding requests over the network. */
export interface RealUdpResult {
  kind: 'real';
  target: string; // host:port actually probed
  packetsSent: number;
  packetsReceived: number;
  lossPct: number | NotAvailable;
  rtt: { min: number; avg: number; max: number } | NotAvailable;
  jitterMs: number | NotAvailable;
  ppsSent: number | NotAvailable;
  ppsReceived: number | NotAvailable;
  localAddress: string | NotAvailable; // bound local socket address:port
  localInterface: string | NotAvailable; // best-effort NIC name+ip, else NOT_AVAILABLE
  reflexiveAddress: string | NotAvailable; // public mapped addr (XOR-MAPPED-ADDRESS)
  durationMs: number;
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  verdict: Verdict;
  rttSamples: number[]; // raw measured RTTs for received replies
  note: string; // honesty caveat shown to the user
}

/** Result of the SAFE loopback SIMULATION with software-injected packet loss. */
export interface SimUdpResult {
  kind: 'sim';
  target: string; // loopback target used (e.g. 127.0.0.1:PORT)
  baseline: { sent: number; received: number; lossPct: number | NotAvailable; ppsReceived: number | NotAvailable };
  artificial: {
    sent: number;
    received: number;
    lossPct: number | NotAvailable;
    injectedLossPct: number; // loss deliberately injected in software (receiver)
  };
  deltaLossPct: number | NotAvailable;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  verdict: Verdict;
  note: string; // clearly states the loss is artificial / software-injected
}

export type UdpResult = RealUdpResult | SimUdpResult;
