/** Pure, testable helpers for the new games (emoji/flag guess + hangman). */

export function normalizeAr(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[ً-ْ]/g, '') // harakat
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

/** Does a free-text guess match any accepted answer (whole-word or exact)? */
export function matchAnswer(guess: string, answers: string[]): boolean {
  const ng = normalizeAr(guess);
  const words = ng.split(/\s+/);
  return answers.some((a) => {
    const na = normalizeAr(a);
    return ng === na || words.includes(na);
  });
}

// ---- Hangman ----
export interface HangmanState {
  word: string; // original display word
  revealed: Set<string>; // normalized letters correctly guessed
  missed: Set<string>; // normalized letters guessed wrong
  wrong: number;
  max: number;
}

export function newHangman(word: string, max = 6): HangmanState {
  return { word, revealed: new Set(), missed: new Set(), wrong: 0, max };
}

export function maskWord(state: HangmanState): string {
  return state.word
    .split('')
    .map((ch) => (ch === ' ' ? ' ' : state.revealed.has(normalizeAr(ch)) ? ch : 'ـ'))
    .join(' ');
}

export type GuessResult = 'hit' | 'miss' | 'dup';

export function hangmanGuess(state: HangmanState, letter: string): GuessResult {
  const L = normalizeAr(letter);
  if (!L) return 'dup';
  if (state.revealed.has(L) || state.missed.has(L)) return 'dup';
  const inWord = state.word.split('').some((ch) => normalizeAr(ch) === L);
  if (inWord) {
    state.revealed.add(L);
    return 'hit';
  }
  state.missed.add(L);
  state.wrong += 1;
  return 'miss';
}

export function hangmanWon(state: HangmanState): boolean {
  return state.word.split('').every((ch) => ch === ' ' || state.revealed.has(normalizeAr(ch)));
}

export function hangmanLost(state: HangmanState): boolean {
  return state.wrong >= state.max;
}
