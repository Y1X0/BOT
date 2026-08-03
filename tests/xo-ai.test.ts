import { describe, it, expect } from 'vitest';
import { winner, bestMove, isDraw, type Cell, type Mark } from '../src/services/xo-ai';

const B = (s: string): Cell[] => s.split('').map((c) => (c === '.' ? ' ' : c)) as Cell[];

describe('winner', () => {
  it('detects rows, columns and diagonals', () => {
    expect(winner(B('XXX......'))).toBe('X');
    expect(winner(B('O..O..O..'))).toBe('O');
    expect(winner(B('X...X...X'))).toBe('X');
    expect(winner(B('..O.O.O..'))).toBe('O');
  });
  it('returns null when there is no line', () => {
    expect(winner(B('XOXOXOOXO'))).toBeNull();
    expect(winner(B('.........'))).toBeNull();
  });
});

describe('bestMove', () => {
  it('takes an immediate winning move', () => {
    // O at 0,1 → completes the top row at 2.
    expect(bestMove(B('OO.......'), 'O')).toBe(2);
  });
  it('blocks the opponent’s immediate win', () => {
    // X threatens the top row; O must play 2.
    expect(bestMove(B('XX.......'), 'O')).toBe(2);
  });
  it('returns -1 on a full board', () => {
    expect(bestMove(B('XOXOXOOXO'), 'O')).toBe(-1);
  });
});

// Exhaustively verify the minimax opponent is unbeatable: explore every line
// where one side plays all moves and the other answers with bestMove.
function playOut(board: Cell[], toMove: Mark, ai: Mark): 'X' | 'O' | 'draw' {
  const w = winner(board);
  if (w) return w;
  if (isDraw(board)) return 'draw';
  if (toMove === ai) {
    const b = [...board];
    b[bestMove(b, ai)] = ai;
    return playOut(b, ai === 'X' ? 'O' : 'X', ai);
  }
  // The human side tries every legal move; keep the best achievable for it.
  const results: Array<'X' | 'O' | 'draw'> = [];
  for (let i = 0; i < 9; i++) {
    if (board[i] !== ' ') continue;
    const b = [...board];
    b[i] = toMove;
    results.push(playOut(b, ai, ai));
  }
  if (results.includes(toMove)) return toMove; // human can force a win
  if (results.includes('draw')) return 'draw';
  return ai;
}

describe('minimax is unbeatable', () => {
  it('never loses as the second player (O), human moves first', () => {
    expect(playOut(B('.........'), 'X', 'O')).toBe('draw');
  });
  it('never loses as the first player (O)', () => {
    expect(playOut(B('.........'), 'O', 'O')).toBe('draw');
  });
});
