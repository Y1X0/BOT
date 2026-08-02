import { describe, it, expect } from 'vitest';
import { questionIndex, isQotdDue } from '../src/plugins/qotd/logic';
import { QUESTIONS } from '../src/plugins/qotd/data';

describe('questionIndex', () => {
  it('is within range and stable for the same chat+day', () => {
    const now = new Date('2026-08-02T10:00:00Z');
    const a = questionIndex('123', now, QUESTIONS.length);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(QUESTIONS.length);
    expect(questionIndex('123', now, QUESTIONS.length)).toBe(a);
  });
  it('varies by day (usually)', () => {
    const a = questionIndex('123', new Date('2026-08-02T10:00:00Z'), QUESTIONS.length);
    const b = questionIndex('123', new Date('2026-08-03T10:00:00Z'), QUESTIONS.length);
    const c = questionIndex('999', new Date('2026-08-02T10:00:00Z'), QUESTIONS.length);
    expect(a !== b || a !== c).toBe(true);
  });
});

describe('isQotdDue', () => {
  it('fires at the target hour when never posted', () => {
    expect(isQotdDue(new Date('2026-08-02T10:00:00Z'), null)).toBe(true);
  });
  it('does not fire at other hours', () => {
    expect(isQotdDue(new Date('2026-08-02T09:00:00Z'), null)).toBe(false);
  });
  it('does not fire twice in the same day', () => {
    const last = new Date('2026-08-02T10:00:00Z');
    expect(isQotdDue(new Date('2026-08-02T10:30:00Z'), last)).toBe(false);
  });
  it('fires again the next day', () => {
    const last = new Date('2026-08-01T10:00:00Z');
    expect(isQotdDue(new Date('2026-08-02T10:00:00Z'), last)).toBe(true);
  });
});
