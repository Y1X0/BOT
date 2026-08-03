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

/** Job flavours for /work; each pays within [WORK_MIN, WORK_MAX]. */
export const WORK_JOBS = [
  'برمجت تطبيقاً 💻',
  'وصّلت طلبات ديليفري 🛵',
  'صمّمت شعاراً 🎨',
  'كتبت مقالاً ✍️',
  'أصلحت سيارة 🔧',
  'درّست طلاباً 📚',
  'بعت قهوة ☕',
  'صوّرت حفلة 📸',
];
export const WORK_MIN = 50;
export const WORK_MAX = 250;

export interface WorkReward {
  amount: number;
  job: string;
}

/** Pick a random job + payout for /work. `rand` injectable for tests. */
export function workReward(rand: () => number): WorkReward {
  const job = WORK_JOBS[Math.floor(rand() * WORK_JOBS.length)];
  const amount = WORK_MIN + Math.floor(rand() * (WORK_MAX - WORK_MIN + 1));
  return { job, amount };
}

export const CRIME_SUCCESS_CHANCE = 0.55;
export const CRIME_WINS = [
  'سطوت على بنك 🏦',
  'سرقت متجراً 🏪',
  'اخترقت حساباً 💳',
  'هرّبت بضاعة 📦',
];
export const CRIME_FAILS = [
  'أمسكت بك الشرطة 🚓',
  'انطلق الإنذار 🚨',
  'وشى بك شريكك 🤝',
  'سقطت من النافذة 🪟',
];

export interface CrimeOutcome {
  success: boolean;
  amount: number; // reward (success) or fine (fail)
  story: string;
}

/**
 * Attempt a crime: on success win 150–600 coins, on failure pay a fine that is
 * 20% of the current wallet (min 50). `rand` injectable for deterministic tests.
 */
export function crimeOutcome(wallet: number, rand: () => number): CrimeOutcome {
  if (rand() < CRIME_SUCCESS_CHANCE) {
    const amount = 150 + Math.floor(rand() * 451); // 150–600
    return { success: true, amount, story: CRIME_WINS[Math.floor(rand() * CRIME_WINS.length)] };
  }
  const fine = Math.max(50, Math.floor(wallet * 0.2));
  return { success: false, amount: fine, story: CRIME_FAILS[Math.floor(rand() * CRIME_FAILS.length)] };
}
