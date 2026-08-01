import { describe, it, expect } from 'vitest';
import { translate, makeTranslator, isSupportedLocale } from '../src/locales';

describe('i18n', () => {
  it('translates a known key with interpolation', () => {
    const out = translate('ar', 'info.time', { time: '12:00' });
    expect(out).toContain('12:00');
  });

  it('falls back to Arabic when key missing in locale', () => {
    // en is missing "nonexistent" → falls back to ar → falls back to key
    expect(translate('en', 'totally.missing.key')).toBe('totally.missing.key');
  });

  it('interpolates multiple variables', () => {
    const out = translate('en', 'mod.warned', {
      name: 'Sami',
      count: 2,
      max: 3,
      reason: 'spam',
    });
    expect(out).toContain('Sami');
    expect(out).toContain('2');
    expect(out).toContain('3');
    expect(out).toContain('spam');
  });

  it('makeTranslator binds locale', () => {
    const t = makeTranslator('en');
    expect(t('settings.on')).toBe('ON');
  });

  it('validates supported locales', () => {
    expect(isSupportedLocale('ar')).toBe(true);
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
  });
});
