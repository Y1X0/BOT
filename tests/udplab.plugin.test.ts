import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the UDP engine so the handler test is fast and deterministic (no sockets).
// A full, valid SimUdpResult so render() works end-to-end.
vi.mock('../src/services/udplab/runner', () => ({
  runSimTest: vi.fn(async () => ({
    kind: 'sim',
    target: '127.0.0.1 (loopback)',
    baseline: { sent: 200, received: 200, lossPct: 0, ppsReceived: 200 },
    artificial: { sent: 200, received: 140, lossPct: 30, injectedLossPct: 30 },
    deltaLossPct: 30,
    durationMs: 1000,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    verdict: 'PASS',
    note: 'n',
  })),
  runRealUdpTest: vi.fn(async () => ({
    kind: 'real',
    target: 'stun.l.google.com:19302',
    packetsSent: 4,
    packetsReceived: 0,
    lossPct: 100,
    rtt: 'NOT_AVAILABLE',
    jitterMs: 'NOT_AVAILABLE',
    ppsSent: 'NOT_AVAILABLE',
    ppsReceived: 'NOT_AVAILABLE',
    localAddress: 'NOT_AVAILABLE',
    localInterface: 'NOT_AVAILABLE',
    reflexiveAddress: 'NOT_AVAILABLE',
    durationMs: 1000,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    verdict: 'FAIL',
    rttSamples: [],
    note: 'n',
  })),
}));

// Mock the store so we control the save outcome (id vs null).
vi.mock('../src/services/udplab/store', () => ({
  saveExperiment: vi.fn(),
  lastExperiment: vi.fn(async () => null),
  experimentHistory: vi.fn(async () => []),
  parseStored: vi.fn(() => null),
}));

import { executeRun } from '../src/plugins/udplab';
import { saveExperiment } from '../src/services/udplab/store';

const NOT_SAVED_MARK = 'تعذّر حفظه في قاعدة البيانات';

function makeCtx() {
  const edits: string[] = [];
  const ctx: any = {
    from: { id: 111 }, // owner (OWNER_IDS in tests/setup)
    chat: { id: 999 },
    telegram: {
      editMessageText: async (_chatId: number, _msgId: number, _inline: unknown, text: string) => {
        edits.push(text);
        return true;
      },
    },
  };
  return { ctx, edits };
}

describe('udplab plugin — save-result feedback in the rendered message', () => {
  beforeEach(() => vi.clearAllMocks());

  it('save SUCCEEDS → message is the plain result, NO "not saved" notice', async () => {
    (saveExperiment as any).mockResolvedValue(42); // saved with id 42
    const { ctx, edits } = makeCtx();
    await executeRun(ctx, 'sim', 1, 999);
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain('محاكاة UDP'); // normal sim render present
    expect(edits[0]).not.toContain(NOT_SAVED_MARK); // success path unchanged
  });

  it('save FAILS (null) → same result PLUS a clear "not saved" notice', async () => {
    (saveExperiment as any).mockResolvedValue(null); // DB unreachable
    const { ctx, edits } = makeCtx();
    await executeRun(ctx, 'sim', 1, 999);
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain('محاكاة UDP'); // result still shown (real values kept)
    expect(edits[0]).toContain(NOT_SAVED_MARK); // and the warning is appended
    expect(edits[0]).toContain('/udp_report'); // tells the user where it won't appear
  });

  it('saveExperiment is called exactly once per run', async () => {
    (saveExperiment as any).mockResolvedValue(7);
    const { ctx } = makeCtx();
    await executeRun(ctx, 'sim', 1, 999);
    expect((saveExperiment as any)).toHaveBeenCalledTimes(1);
    expect((saveExperiment as any).mock.calls[0][0]).toBe(111n); // runBy = owner id as BigInt
  });
});
