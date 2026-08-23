import { describe, it, expect } from 'vitest';
import { installEmojiSubstitution } from '../src/services/emojiMap';

/** Capture the payload the wrapped callApi forwards to Telegram. */
function makeTg() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const tg = {
    callApi: async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
      return { message_id: 1 };
    },
  };
  installEmojiSubstitution(tg as never);
  return { tg, calls };
}

describe('outgoing HTML auto-enable', () => {
  it('sets parse_mode HTML for a plain <b> message (e.g. the mute reply)', async () => {
    const { tg, calls } = makeTg();
    await tg.callApi('sendMessage', { chat_id: 1, text: '🔇 تم كتم <b>أحمد</b>.' });
    expect(calls[0].payload.parse_mode).toBe('HTML');
    expect(calls[0].payload.text).toBe('🔇 تم كتم <b>أحمد</b>.');
  });

  it('does NOT auto-enable when the caller already set a parse_mode', async () => {
    const { tg, calls } = makeTg();
    await tg.callApi('sendMessage', { chat_id: 1, text: '<b>x</b>', parse_mode: 'MarkdownV2' });
    expect(calls[0].payload.parse_mode).toBe('MarkdownV2');
  });

  it('leaves plain messages (no tags) untouched', async () => {
    const { tg, calls } = makeTg();
    await tg.callApi('sendMessage', { chat_id: 1, text: 'مرحبا 👋' });
    expect(calls[0].payload.parse_mode).toBeUndefined();
  });
});
