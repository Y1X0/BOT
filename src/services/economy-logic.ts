/** Pure economy helpers (no DB) so the odds/payout maths can be unit tested. */

export interface RobDecision {
  success: boolean;
  amount: number; // stolen (success) or fine paid (caught)
}

export const ROB_SUCCESS_CHANCE = 0.4;

/** Decide a robbery outcome. `rand` is injectable for deterministic tests. */
export function robOutcome(victimWallet: number, robberWallet: number, rand: () => number): RobDecision {
  if (rand() < ROB_SUCCESS_CHANCE) {
    const pct = 0.1 + rand() * 0.2; // steal 10–30% of the victim's wallet
    return { success: true, amount: Math.max(1, Math.floor(victimWallet * pct)) };
  }
  return { success: false, amount: Math.max(1, Math.floor(robberWallet * 0.1)) }; // caught → lose 10%
}

export const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'];

export interface SlotResult {
  reels: string[];
  mult: number;
}

/** Spin three reels; three-of-a-kind pays big, a pair pays small. */
export function spinSlots(rand: () => number): SlotResult {
  const reels = [0, 1, 2].map(() => SLOT_SYMBOLS[Math.floor(rand() * SLOT_SYMBOLS.length)]);
  let mult = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    mult = reels[0] === '7️⃣' ? 10 : reels[0] === '💎' ? 7 : 5;
  } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    mult = 1.5;
  }
  return { reels, mult };
}
