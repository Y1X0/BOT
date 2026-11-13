import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * These set GH_DL_* BEFORE importing the module, because config/env.ts parses
 * process.env once at import time.
 */
describe('githubDl — dispatch (configured)', () => {
  let mod: typeof import('../src/services/githubDl');
  const calls: { url: string; opts: any }[] = [];

  beforeAll(async () => {
    process.env.GH_DL_TOKEN = 'ghp_test_token';
    process.env.GH_DL_REPO = 'Owner/Repo';
    process.env.GH_DL_WORKFLOW = 'dl.yml';
    process.env.GH_DL_REF = 'mybranch';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts: any) => {
        calls.push({ url, opts });
        return { status: 204, text: async () => '' } as unknown as Response;
      }),
    );
    mod = await import('../src/services/githubDl');
  });

  it('is enabled when a token is configured', () => {
    expect(mod.githubDlEnabled()).toBe(true);
  });

  it('POSTs to the correct workflow-dispatch URL with the right inputs', async () => {
    calls.length = 0;
    const ok = await mod.dispatchGithubDownload({ url: 'https://youtu.be/abc', mode: 'audio', chatId: -100123 });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/Owner/Repo/actions/workflows/dl.yml/dispatches');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer ghp_test_token');
    const body = JSON.parse(calls[0].opts.body);
    expect(body.ref).toBe('mybranch');
    expect(body.inputs).toMatchObject({
      url: 'https://youtu.be/abc',
      mode: 'audio',
      target: '-100123', // chat id stringified (handles negative group ids)
      quality: '720',
    });
  });

  it('returns false (no throw) when GitHub rejects the dispatch', async () => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, text: async () => 'Not Found' }) as unknown as Response),
    );
    const ok = await mod.dispatchGithubDownload({ url: 'x', mode: 'video', chatId: 1 });
    expect(ok).toBe(false);
  });

  it('returns false (no throw) when fetch itself throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const ok = await mod.dispatchGithubDownload({ url: 'x', mode: 'audio', chatId: 1 });
    expect(ok).toBe(false);
  });
});
