import type { Pet } from '@prisma/client';
import { prisma } from '../core/database';
import { decay, HUNGER_DECAY_PER_HOUR, HAPPINESS_DECAY_PER_HOUR, PET_SPECIES } from './pet-logic';

export interface LivePet extends Pet {
  hunger: number;
  happiness: number;
}

/** Current pet with decay applied (does not persist the decay itself). */
function applyDecay(pet: Pet, now: Date): LivePet {
  const hungerHours = (now.getTime() - pet.lastFedAt.getTime()) / 3_600_000;
  const happyHours = (now.getTime() - pet.lastPlayedAt.getTime()) / 3_600_000;
  return {
    ...pet,
    hunger: decay(pet.hunger, HUNGER_DECAY_PER_HOUR, hungerHours),
    happiness: decay(pet.happiness, HAPPINESS_DECAY_PER_HOUR, happyHours),
  };
}

export async function getPet(chatId: number | bigint, userId: number | bigint, now = new Date()): Promise<LivePet | null> {
  const pet = await prisma.pet.findUnique({
    where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
  });
  return pet ? applyDecay(pet, now) : null;
}

export async function adoptPet(
  chatId: number | bigint,
  userId: number | bigint,
  name: string,
  species: string,
): Promise<LivePet> {
  const pet = await prisma.pet.create({
    data: { chatId: BigInt(chatId), userId: BigInt(userId), name: name.slice(0, 40), species },
  });
  return applyDecay(pet, new Date());
}

/** Pick a deterministic-ish species from the user id (no RNG needed). */
export function speciesFor(userId: number | bigint): string {
  return PET_SPECIES[Number(BigInt(userId) % BigInt(PET_SPECIES.length))];
}

/** Persist feed: restore hunger, bump xp, stamp lastFedAt. Returns the fresh pet. */
export async function feedPet(
  chatId: number | bigint,
  userId: number | bigint,
  hungerGain: number,
  xpGain: number,
  now = new Date(),
): Promise<LivePet | null> {
  const live = await getPet(chatId, userId, now);
  if (!live) return null;
  const updated = await prisma.pet.update({
    where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
    data: { hunger: Math.min(100, live.hunger + hungerGain), xp: live.xp + xpGain, lastFedAt: now },
  });
  return applyDecay(updated, now);
}

/** Persist play: restore happiness, bump xp, stamp lastPlayedAt. */
export async function playPet(
  chatId: number | bigint,
  userId: number | bigint,
  happyGain: number,
  xpGain: number,
  now = new Date(),
): Promise<LivePet | null> {
  const live = await getPet(chatId, userId, now);
  if (!live) return null;
  const updated = await prisma.pet.update({
    where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
    data: { happiness: Math.min(100, live.happiness + happyGain), xp: live.xp + xpGain, lastPlayedAt: now },
  });
  return applyDecay(updated, now);
}

/** Write back a level/xp change after an XP roll-up. */
export async function setPetLevel(
  chatId: number | bigint,
  userId: number | bigint,
  level: number,
  xp: number,
): Promise<void> {
  await prisma.pet.update({
    where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } },
    data: { level, xp },
  });
}

export async function topPets(chatId: number | bigint, limit = 10): Promise<Pet[]> {
  return prisma.pet.findMany({
    where: { chatId: BigInt(chatId) },
    orderBy: [{ level: 'desc' }, { xp: 'desc' }],
    take: limit,
  });
}
