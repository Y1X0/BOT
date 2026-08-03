import { describe, it, expect } from 'vitest';
import { parseDuration, formatDuration } from '../src/utils/duration';

describe('parseDuration', () => {
  it('parses latin units', () => {
    expect(parseDuration('45s')).toBe(45);
    expect(parseDuration('30m')).toBe(1800);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('1d')).toBe(86400);
    expect(parseDuration('1w')).toBe(604800);
  });

  it('treats a bare number as minutes', () => {
    expect(parseDuration('30')).toBe(1800);
  });

  it('tolerates whitespace and case', () => {
    expect(parseDuration('  2H ')).toBe(7200);
  });

  it('parses arabic unit aliases', () => {
    expect(parseDuration('30د')).toBe(1800); // minutes
    expect(parseDuration('2س')).toBe(7200); // hours
    expect(parseDuration('1ي')).toBe(86400); // days
  });

  it('rejects invalid input', () => {
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
    expect(parseDuration('5x')).toBeNull();
  });

  it('caps at 365 days', () => {
    expect(parseDuration('999d')).toBe(365 * 86400);
  });
});

describe('formatDuration', () => {
  it('renders the largest sensible unit', () => {
    expect(formatDuration(45)).toBe('45 ثانية');
    expect(formatDuration(1800)).toBe('30 دقيقة');
    expect(formatDuration(7200)).toBe('2 ساعة');
    expect(formatDuration(86400)).toBe('1 يوم');
  });
});
