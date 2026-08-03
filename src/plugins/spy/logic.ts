/** Pure helpers for the Spy game (role assignment) — no I/O, so it's testable. */

export const SPY_WORDS = [
  'مطار', 'مستشفى', 'مدرسة', 'ملعب كرة', 'مطعم', 'شاطئ', 'سينما', 'بنك',
  'سوبرماركت', 'محطة قطار', 'طائرة', 'فندق', 'حديقة حيوان', 'صيدلية',
  'صالون حلاقة', 'محطة وقود', 'متحف', 'مكتبة', 'سفينة', 'مخيم', 'مقهى',
  'صالة رياضة', 'قصر', 'غواصة', 'محكمة',
];

export interface SpyAssignment {
  spyId: number;
  word: string;
}

/** Pick one player to be the spy and a secret word. `rand` injectable for tests. */
export function assignRoles(playerIds: number[], words: string[], rand: () => number): SpyAssignment {
  const spyId = playerIds[Math.floor(rand() * playerIds.length)];
  const word = words[Math.floor(rand() * words.length)];
  return { spyId, word };
}
