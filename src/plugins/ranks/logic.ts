/** Automatic rank tiers derived purely from a member's level. */

export interface Rank {
  minLevel: number;
  emoji: string;
  name: string;
}

// Ordered ascending by minLevel.
export const RANKS: Rank[] = [
  { minLevel: 0, emoji: '🌱', name: 'عضو جديد' },
  { minLevel: 3, emoji: '🙂', name: 'عضو' },
  { minLevel: 5, emoji: '💬', name: 'عضو نشط' },
  { minLevel: 10, emoji: '🔥', name: 'متفاعل' },
  { minLevel: 20, emoji: '⭐', name: 'نجم الجروب' },
  { minLevel: 30, emoji: '🏆', name: 'محترف' },
  { minLevel: 50, emoji: '👑', name: 'أسطورة' },
  { minLevel: 75, emoji: '💎', name: 'خارق' },
  { minLevel: 100, emoji: '🦋', name: 'خالد' },
];

/** Highest rank whose threshold the level has reached. */
export function rankForLevel(level: number): Rank {
  let current = RANKS[0];
  for (const r of RANKS) {
    if (level >= r.minLevel) current = r;
    else break;
  }
  return current;
}

/** The next rank above the current level, or null if already at the top. */
export function nextRank(level: number): Rank | null {
  return RANKS.find((r) => r.minLevel > level) ?? null;
}

/** Did leveling from `prevLevel` to `newLevel` cross into a new rank? */
export function crossedRank(prevLevel: number, newLevel: number): Rank | null {
  const before = rankForLevel(prevLevel);
  const after = rankForLevel(newLevel);
  return after.name !== before.name ? after : null;
}
