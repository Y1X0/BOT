import { describe, it, expect } from 'vitest';
import { parseIdAndText, parseId, snippet } from '../src/plugins/tickets/logic';

describe('parseIdAndText', () => {
  it('splits a leading id from the rest', () => {
    expect(parseIdAndText('5 مرحبا كيف الحال')).toEqual({ id: 5, text: 'مرحبا كيف الحال' });
    expect(parseIdAndText('12   نص  متعدد   المسافات')).toEqual({ id: 12, text: 'نص  متعدد   المسافات' });
  });
  it('rejects malformed input', () => {
    expect(parseIdAndText('5')).toBeNull(); // no text
    expect(parseIdAndText('نص بدون رقم')).toBeNull();
    expect(parseIdAndText('')).toBeNull();
  });
});

describe('parseId', () => {
  it('accepts positive integers only', () => {
    expect(parseId('7')).toBe(7);
    expect(parseId(' 3 ')).toBe(3);
    expect(parseId('0')).toBeNull();
    expect(parseId('abc')).toBeNull();
    expect(parseId('1.5')).toBeNull();
  });
});

describe('snippet', () => {
  it('collapses whitespace and truncates', () => {
    expect(snippet('a   b\nc')).toBe('a b c');
    expect(snippet('x'.repeat(80), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});
