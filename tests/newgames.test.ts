import { describe, it, expect } from 'vitest';
import {
  matchAnswer,
  normalizeAr,
  newHangman,
  maskWord,
  hangmanGuess,
  hangmanWon,
  hangmanLost,
} from '../src/plugins/newgames/logic';

describe('answer matching', () => {
  it('matches exact and whole-word, ignoring diacritics/alef forms', () => {
    expect(matchAnswer('السعوديه', ['السعودية'])).toBe(true);
    expect(matchAnswer('هي مصر', ['مصر'])).toBe(true);
    expect(matchAnswer('الأردن', ['الاردن'])).toBe(true);
  });
  it('does not false-match a substring inside a longer word', () => {
    expect(matchAnswer('قطرة', ['قطر'])).toBe(false);
  });
  it('normalizes ta-marbuta and hamza', () => {
    expect(normalizeAr('قَهْوَة')).toBe('قهوه');
    expect(normalizeAr('إيطاليا')).toBe('ايطاليا');
  });
});

describe('hangman', () => {
  it('reveals correct letters and masks the rest', () => {
    const g = newHangman('قمر');
    expect(hangmanGuess(g, 'ق')).toBe('hit');
    expect(maskWord(g)).toBe('ق ـ ـ');
    expect(hangmanWon(g)).toBe(false);
  });
  it('detects a win when all letters revealed', () => {
    const g = newHangman('قمر');
    hangmanGuess(g, 'ق');
    hangmanGuess(g, 'م');
    hangmanGuess(g, 'ر');
    expect(hangmanWon(g)).toBe(true);
  });
  it('counts wrong guesses and loses at max', () => {
    const g = newHangman('قمر', 2);
    expect(hangmanGuess(g, 'ب')).toBe('miss');
    expect(hangmanLost(g)).toBe(false);
    expect(hangmanGuess(g, 'ت')).toBe('miss');
    expect(hangmanLost(g)).toBe(true);
  });
  it('flags duplicate guesses', () => {
    const g = newHangman('قمر');
    hangmanGuess(g, 'ق');
    expect(hangmanGuess(g, 'ق')).toBe('dup');
  });
  it('matches ta-marbuta letter via normalized haa', () => {
    const g = newHangman('وردة');
    expect(hangmanGuess(g, 'ه')).toBe('hit'); // ة normalizes to ه
    expect(maskWord(g)).toBe('ـ ـ ـ ة');
  });
});
