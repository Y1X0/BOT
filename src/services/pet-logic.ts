/** Pure virtual-pet maths (decay, levels, mood) — no DB, so it's unit-testable. */

// Stats drop by these many points per hour since the last feed/play.
export const HUNGER_DECAY_PER_HOUR = 4;
export const HAPPINESS_DECAY_PER_HOUR = 3;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Apply time-based decay to a stat given the hours elapsed. */
export function decay(value: number, perHour: number, hoursElapsed: number): number {
  if (hoursElapsed <= 0) return clamp(value);
  return clamp(value - perHour * hoursElapsed);
}

/** XP needed to reach the next level (grows with level). */
export function xpForLevel(level: number): number {
  return 50 + level * 30;
}

/** Apply an XP gain, rolling levels up while enough XP remains. */
export function addPetXp(level: number, xp: number, gain: number): { level: number; xp: number; leveledUp: boolean } {
  let lvl = level;
  let total = xp + gain;
  let leveledUp = false;
  while (total >= xpForLevel(lvl)) {
    total -= xpForLevel(lvl);
    lvl += 1;
    leveledUp = true;
  }
  return { level: lvl, xp: total, leveledUp };
}

/** A mood label from the current hunger + happiness. */
export function mood(hunger: number, happiness: number): string {
  const avg = (hunger + happiness) / 2;
  if (hunger <= 15) return 'جائع جداً 🥺';
  if (happiness <= 15) return 'حزين 😢';
  if (avg >= 80) return 'سعيد جداً 🥰';
  if (avg >= 55) return 'بخير 🙂';
  if (avg >= 30) return 'متعب 😕';
  return 'مريض 🤒';
}

/** A little bar like ████░░░░ for a 0..100 stat. */
export function bar(value: number): string {
  const filled = Math.round(clamp(value) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export const PET_SPECIES = ['🐶', '🐱', '🐰', '🦊', '🐼', '🐦', '🐹', '🐢'];
