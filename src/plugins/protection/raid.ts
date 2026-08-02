/**
 * Sliding-window raid detector. Pure and side-effect free so it can be unit
 * tested: a "raid" is N or more joins within `windowMs`. Once triggered, the
 * chat stays in raid mode for `cooldownMs` so the burst is fully contained.
 */
export interface RaidState {
  joins: number[]; // recent join timestamps (ms)
  raidUntil: number; // raid mode active while now < raidUntil
}

export function makeRaidState(): RaidState {
  return { joins: [], raidUntil: 0 };
}

export interface RaidResult {
  raid: boolean; // is the chat currently in raid mode?
  justTriggered: boolean; // did THIS join tip it into raid mode?
}

export function recordJoin(
  state: RaidState,
  now: number,
  threshold: number,
  windowMs: number,
  cooldownMs: number,
): RaidResult {
  state.joins.push(now);
  state.joins = state.joins.filter((t) => now - t <= windowMs);

  if (state.raidUntil > now) return { raid: true, justTriggered: false };

  if (state.joins.length >= threshold) {
    state.raidUntil = now + cooldownMs;
    return { raid: true, justTriggered: true };
  }
  return { raid: false, justTriggered: false };
}

export function inRaid(state: RaidState, now: number): boolean {
  return state.raidUntil > now;
}
