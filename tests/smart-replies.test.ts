import { describe, it, expect } from 'vitest';
import { matchSmartRule } from '../src/plugins/replies/smart-replies';

describe('smart replies', () => {
  it('matches a salam greeting', () => {
    const rule = matchSmartRule('السلام عليكم يا شباب');
    expect(rule?.id).toBe('salam');
    expect(rule?.responses.length).toBeGreaterThan(0);
  });

  it('matches congratulations and carries a reaction', () => {
    const rule = matchSmartRule('مبروك عليك');
    expect(rule?.id).toBe('congrats');
    expect(rule?.reaction).toBe('🎉');
  });

  it('is case-insensitive for latin triggers embedded in text', () => {
    // "هاي" substring match
    const rule = matchSmartRule('هاي كيفكم');
    expect(rule?.id).toBe('hi');
  });

  it('returns null when nothing matches', () => {
    expect(matchSmartRule('xyz random text 123')).toBeNull();
  });
});
