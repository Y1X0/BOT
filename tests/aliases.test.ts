import { describe, it, expect } from 'vitest';
import { matchAlias } from '../src/plugins/aliases';

describe('Arabic command aliases', () => {
  it('maps a simple word to its command', () => {
    expect(matchAlias('نكته')).toBe('/joke');
    expect(matchAlias('الوقت')).toBe('/time');
    expect(matchAlias('رصيدي')).toBe('/balance');
  });

  it('is tolerant to hamza/ta-marbuta variations', () => {
    // "نكتة" (ta-marbuta) should normalize to the same as "نكته"
    expect(matchAlias('نكتة')).toBe('/joke');
    expect(matchAlias('صراحة')).toBe('/truth');
  });

  it('preserves arguments after the trigger', () => {
    expect(matchAlias('الطقس الرياض')).toBe('/weather الرياض');
    expect(matchAlias('طقس جدة')).toBe('/weather جدة');
  });

  it('matches multi-word triggers', () => {
    expect(matchAlias('حجر ورقه مقص')).toBe('/rps');
    expect(matchAlias('لو خيروك')).toBe('/wyr');
  });

  it('ignores real slash commands and non-matches', () => {
    expect(matchAlias('/joke')).toBeNull();
    expect(matchAlias('كلام عادي ما يطابق شيء')).toBeNull();
    expect(matchAlias('')).toBeNull();
  });

  it('does not confuse similar words', () => {
    // "معلوماتي" → id, "معلومات" → fact (distinct entries)
    expect(matchAlias('معلوماتي')).toBe('/id');
    expect(matchAlias('معلومات')).toBe('/fact');
  });
});
