import { describe, it, expect } from 'vitest';
import { pickTtsText } from '../src/plugins/tts';

describe('pickTtsText', () => {
  it('prefers the inline argument', () => {
    expect(pickTtsText('اقرأ هذا النص', 'replied')).toBe('اقرأ هذا النص');
  });
  it('falls back to the replied text when there is no argument', () => {
    expect(pickTtsText('', 'نص الرسالة المردود عليها')).toBe('نص الرسالة المردود عليها');
    expect(pickTtsText(undefined, 'مرحبا')).toBe('مرحبا');
  });
  it('trims and returns null when nothing to speak', () => {
    expect(pickTtsText('   ', '  ')).toBeNull();
    expect(pickTtsText(undefined, undefined)).toBeNull();
  });
});
