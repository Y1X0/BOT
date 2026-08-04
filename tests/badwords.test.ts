import { describe, it, expect } from 'vitest';
import { containsBadword, normalizeForMatch } from '../src/services/badwords';

describe('normalizeForMatch', () => {
  it('strips diacritics, tatweel and normalizes letters', () => {
    expect(normalizeForMatch('كِتَاـــبة')).toBe('كتابه');
    expect(normalizeForMatch('أإآ ى ة')).toBe('اا ي ه'); // 3 alefs collapse to 2
  });
  it('collapses long letter repeats', () => {
    expect(normalizeForMatch('حراااااام')).toBe('حراام');
  });
});

describe('containsBadword — flags insults', () => {
  const bad = [
    'كسمك يا حقير',
    'يا ابن الشرموطه',
    'انت متناك',
    'روح يا عرص',
    'كس اختك',       // spaced family insult
    'يا قحبه',
    'شرموط',
    'ك س م ك',        // spacing-evasion
    'يا خول',
    'طيزك',
    'يا منيوك',
  ];
  for (const t of bad) {
    it(`flags: "${t}"`, () => expect(containsBadword(t)).toBe(true));
  }
});

describe('containsBadword — leaves normal words alone', () => {
  const ok = [
    'كسر الزجاج على الأرض',      // كسر (break) — not كس*
    'أنا كسلان اليوم',           // كسل (lazy)
    'اكتسب خبرة كبيرة',          // كسب (earn)
    'التخويل الرسمي للمدير',      // خويل / خول inside تخويل
    'زبدة الفول لذيذة',          // زب inside زبده
    'مرحبا كيف حالكم يا شباب',
    'ذهبت إلى المكتبة اليوم',
    'الطيور تطير في السماء',      // طير — not طيز
    'عيد ميلاد سعيد',            // contains عير? no → عيد
  ];
  for (const t of ok) {
    it(`allows: "${t}"`, () => expect(containsBadword(t)).toBe(false));
  }
});
