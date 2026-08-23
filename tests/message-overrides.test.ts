import { describe, it, expect } from 'vitest';
import { normalizeKey } from '../src/services/message-overrides.service';

describe('message-overrides normalizeKey', () => {
  it('strips HTML styling tags so tagged and rendered text match', () => {
    expect(normalizeKey('🎵 <b>اكتب اسم الأغنية</b>')).toBe(normalizeKey('🎵 اكتب اسم الأغنية'));
  });

  it('collapses and trims whitespace', () => {
    expect(normalizeKey('  hi   there \n')).toBe('hi there');
  });

  it('keeps emoji and plain content intact', () => {
    expect(normalizeKey('⛔️ ما عندك صلاحية لهذا الأمر.')).toBe('⛔️ ما عندك صلاحية لهذا الأمر.');
  });

  it('a mention/link tag is stripped to its visible text', () => {
    expect(normalizeKey('تم رفع <a href="tg://user?id=1">أحمد</a>')).toBe('تم رفع أحمد');
  });
});
