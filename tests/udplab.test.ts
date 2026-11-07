import { describe, it, expect } from 'vitest';
import {
  NOT_AVAILABLE,
  round,
  packetLossPct,
  rttStats,
  jitterMs,
  pps,
  verdict,
  isSafeSimTarget,
  lossComparison,
  fmt,
} from '../src/services/udplab/stats';

describe('udplab stats — packet loss', () => {
  it('computes loss %', () => {
    expect(packetLossPct(20, 20)).toBe(0);
    expect(packetLossPct(20, 15)).toBe(25);
    expect(packetLossPct(8, 0)).toBe(100);
  });
  it('is NOT_AVAILABLE when nothing was sent', () => {
    expect(packetLossPct(0, 0)).toBe(NOT_AVAILABLE);
    expect(packetLossPct(-1, 0)).toBe(NOT_AVAILABLE);
  });
  it('never returns negative loss if received > sent', () => {
    expect(packetLossPct(10, 12)).toBe(0);
  });
});

describe('udplab stats — RTT', () => {
  it('computes min/avg/max', () => {
    expect(rttStats([10, 20, 30])).toEqual({ min: 10, avg: 20, max: 30 });
  });
  it('ignores invalid samples and is NOT_AVAILABLE when none valid', () => {
    expect(rttStats([-1, -5])).toBe(NOT_AVAILABLE);
    expect(rttStats([])).toBe(NOT_AVAILABLE);
    expect(rttStats([-1, 40, 60])).toEqual({ min: 40, avg: 50, max: 60 });
  });
});

describe('udplab stats — jitter (mean |consecutive RTT diff|)', () => {
  it('needs at least two samples', () => {
    expect(jitterMs([42])).toBe(NOT_AVAILABLE);
    expect(jitterMs([])).toBe(NOT_AVAILABLE);
  });
  it('computes mean absolute consecutive difference', () => {
    // diffs: |20-10|=10, |15-20|=5 -> mean 7.5
    expect(jitterMs([10, 20, 15])).toBe(7.5);
    // constant RTT -> zero jitter
    expect(jitterMs([30, 30, 30])).toBe(0);
  });
});

describe('udplab stats — PPS', () => {
  it('computes packets per second', () => {
    expect(pps(20, 1000)).toBe(20);
    expect(pps(10, 500)).toBe(20);
  });
  it('is NOT_AVAILABLE for non-positive duration', () => {
    expect(pps(5, 0)).toBe(NOT_AVAILABLE);
  });
});

describe('udplab stats — verdict', () => {
  it('NOT_AVAILABLE when nothing sent', () => {
    expect(verdict(0, 0)).toBe('NOT_AVAILABLE');
  });
  it('FAIL when no replies', () => {
    expect(verdict(20, 0)).toBe('FAIL');
  });
  it('PASS within loss threshold, FAIL above it', () => {
    expect(verdict(20, 18)).toBe('PASS'); // 10% loss <= 20%
    expect(verdict(20, 10)).toBe('FAIL'); // 50% loss > 20%
    expect(verdict(20, 18, 5)).toBe('FAIL'); // 10% > custom 5%
  });
});

describe('udplab stats — simulation target safety', () => {
  it('allows loopback and private LAN', () => {
    expect(isSafeSimTarget('127.0.0.1').ok).toBe(true);
    expect(isSafeSimTarget('localhost').ok).toBe(true);
    expect(isSafeSimTarget('::1').ok).toBe(true);
    expect(isSafeSimTarget('10.0.0.5').ok).toBe(true);
    expect(isSafeSimTarget('192.168.1.20').ok).toBe(true);
    expect(isSafeSimTarget('172.16.0.1').ok).toBe(true);
    expect(isSafeSimTarget('172.31.255.254').ok).toBe(true);
  });
  it('refuses public addresses, Telegram, and hostnames', () => {
    expect(isSafeSimTarget('8.8.8.8').ok).toBe(false);
    expect(isSafeSimTarget('149.154.167.51').ok).toBe(false); // Telegram DC range (public)
    expect(isSafeSimTarget('172.32.0.1').ok).toBe(false); // just outside private B
    expect(isSafeSimTarget('example.com').ok).toBe(false);
    expect(isSafeSimTarget('').ok).toBe(false);
  });
});

describe('udplab stats — loss comparison', () => {
  it('reports baseline, artificial, and delta', () => {
    const c = lossComparison({ sent: 100, received: 100 }, { sent: 100, received: 70, injectedLossPct: 30 });
    expect(c.baseline.lossPct).toBe(0);
    expect(c.artificial.lossPct).toBe(30);
    expect(c.artificial.injectedLossPct).toBe(30);
    expect(c.deltaLossPct).toBe(30);
  });
  it('delta is NOT_AVAILABLE when a side cannot be computed', () => {
    const c = lossComparison({ sent: 0, received: 0 }, { sent: 100, received: 70, injectedLossPct: 30 });
    expect(c.baseline.lossPct).toBe(NOT_AVAILABLE);
    expect(c.deltaLossPct).toBe(NOT_AVAILABLE);
  });
});

describe('udplab stats — helpers', () => {
  it('round passes NOT_AVAILABLE through', () => {
    expect(round(NOT_AVAILABLE)).toBe(NOT_AVAILABLE);
    expect(round(1.23456, 2)).toBe(1.23);
  });
  it('fmt renders values and NOT_AVAILABLE', () => {
    expect(fmt(25, '%')).toBe('25%');
    expect(fmt(NOT_AVAILABLE, '%')).toBe(NOT_AVAILABLE);
  });
});
