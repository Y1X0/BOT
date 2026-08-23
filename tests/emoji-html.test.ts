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

describe('outgoing style → entities', () => {
  it('converts a <b> message to clean text + a bold entity (no literal tags)', async () => {
    const { tg, calls } = makeTg();
    await tg.callApi('sendMessage', { chat_id: 1, text: '🔇 تم كتم <b>أحمد</b>.' });
    const p = calls[0].payload as { text: string; entities?: { type: string; offset: number; length: number }[]; parse_mode?: string };
    expect(p.text).toBe('🔇 تم كتم أحمد.');
    expect(p.text).not.toContain('<b>');
    expect(p.parse_mode).toBeUndefined();
    const bold = p.entities?.find((e) => e.type === 'bold');
    expect(bold).toBeTruthy();
    // "أحمد" sits right after "🔇 تم كتم " (🔇 is 2 UTF-16 units)
    expect(p.text.slice(bold!.offset, bold!.offset + bold!.length)).toBe('أحمد');
  });

  it('unescapes entity content so user text is literal, not markup', async () => {
    const { tg, calls } = makeTg();
    // translate() would produce this for a name of "<x>"
    await tg.callApi('sendMessage', { chat_id: 1, text: '<b>&lt;x&gt; &amp; y</b>' });
    const p = calls[0].payload as { text: string };
    expect(p.text).toBe('<x> & y');
  });

  it('leaves an explicit parse_mode untouched', async () => {
    const { tg, calls } = makeTg();
    await tg.callApi('sendMessage', { chat_id: 1, text: '<b>x</b>', parse_mode: 'HTML' });
    expect((calls[0].payload as { parse_mode?: string }).parse_mode).toBe('HTML');
    expect((calls[0].payload as { text: string }).text).toBe('<b>x</b>');
  });

  it('leaves plain messages (no tags) untouched', async () => {
    const { tg, calls } = makeTg();
    await tg.callApi('sendMessage', { chat_id: 1, text: 'مرحبا 👋' });
    const p = calls[0].payload as { text: string; entities?: unknown[]; parse_mode?: string };
    expect(p.text).toBe('مرحبا 👋');
    expect(p.parse_mode).toBeUndefined();
  });
});
