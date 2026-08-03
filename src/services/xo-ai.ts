/** Pure Tic-Tac-Toe (XO) logic + an unbeatable minimax opponent (no I/O). */

export type Cell = ' ' | 'X' | 'O';
export type Mark = 'X' | 'O';

export const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

/** Winning mark on the board, or null. */
export function winner(b: Cell[]): Mark | null {
  for (const [a, c, d] of WIN_LINES) {
    if (b[a] !== ' ' && b[a] === b[c] && b[c] === b[d]) return b[a] as Mark;
  }
  return null;
}

export function isFull(b: Cell[]): boolean {
  return !b.includes(' ');
}

export function isDraw(b: Cell[]): boolean {
  return isFull(b) && winner(b) === null;
}

const other = (m: Mark): Mark => (m === 'X' ? 'O' : 'X');

/** Minimax score from `me`'s perspective; deeper wins are worth slightly less. */
function minimax(b: Cell[], toMove: Mark, me: Mark, depth: number): number {
  const w = winner(b);
  if (w === me) return 10 - depth;
  if (w !== null) return depth - 10;
  if (isFull(b)) return 0;

  const maximizing = toMove === me;
  let best = maximizing ? -Infinity : Infinity;
  for (let i = 0; i < 9; i++) {
    if (b[i] !== ' ') continue;
    b[i] = toMove;
    const score = minimax(b, other(toMove), me, depth + 1);
    b[i] = ' ';
    best = maximizing ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

/**
 * Best move index for `me` on the given board, or -1 if the board is full.
 * Plays optimally: it never loses and takes any available win.
 */
export function bestMove(board: Cell[], me: Mark = 'O'): number {
  let bestScore = -Infinity;
  let move = -1;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== ' ') continue;
    board[i] = me;
    const score = minimax(board, other(me), me, 1);
    board[i] = ' ';
    if (score > bestScore) {
      bestScore = score;
      move = i;
    }
  }
  return move;
}
