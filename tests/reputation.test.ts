import { describe, it, expect } from 'vitest';
import { isThanks, cooldownLeft } from '../src/plugins/reputation/logic';

describe('isThanks', () => {
  it('detects Arabic thanks (with/without diacritics)', () => {
    expect(isThanks('شكراً لك')).toBe(true);
    expect(isThanks('تسلم يا غالي')).toBe(true);
    expect(isThanks('يعطيك العافية')).toBe(true);
    expect(isThanks('مشكور')).toBe(true);
  });
  it('detects English thanks', () => {
    expect(isThanks('thanks a lot')).toBe(true);
    expect(isThanks('Thank you!')).toBe(true);
  });
  it('ignores unrelated text', () => {
    expect(isThanks('كيف حالك اليوم')).toBe(false);
    expect(isThanks('what time is it')).toBe(false);
  });
});

describe('cooldownLeft', () => {
  it('is 0 when never given', () => {
    expect(cooldownLeft(undefined, 1000, 5000)).toBe(0);
  });
  it('returns remaining time within the window', () => {
    expect(cooldownLeft(1000, 3000, 5000)).toBe(3000); // 5000-(3000-1000)
  });
  it('is 0 after the window passes', () => {
    expect(cooldownLeft(1000, 7000, 5000)).toBe(0);
  });
});
