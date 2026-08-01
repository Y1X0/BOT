/**
 * Fun Image Editor effect registry. Each effect is a prompt template applied to
 * the user's photo. Add new effects by appending here — the menu builds itself.
 * Prompts instruct the model to KEEP the person's face/identity and stay
 * tasteful/non-sexual. Body/clothing-altering or gender-swap effects are
 * intentionally excluded to avoid non-consensual or harassing edits.
 */
export interface Effect {
  id: string;
  emoji: string;
  label: string;
  group: string;
  prompt: string;
}

const KEEP = 'Preserve the person’s exact face and identity so they stay recognizable. High quality, tasteful, non-sexual, do not distort facial features.';

function e(id: string, emoji: string, label: string, group: string, desc: string): Effect {
  return { id, emoji, label, group, prompt: `Transform the person in this photo: ${desc}. ${KEEP}` };
}

export const EFFECTS: Effect[] = [
  // Styles
  e('cartoon', '🎨', 'كرتون', 'أنماط', 'render them in a fun 3D cartoon style'),
  e('anime', '🎭', 'أنمي', 'أنماط', 'render them in Japanese anime art style'),
  e('oil', '🖌', 'لوحة زيتية', 'أنماط', 'render them as a classical oil painting'),
  e('pixel', '📺', 'بيكسل آرت', 'أنماط', 'render them as retro pixel art'),
  e('neon', '🌈', 'نيون', 'أنماط', 'add a glowing neon cyberpunk style'),
  e('sketch', '✏️', 'رسم', 'أنماط', 'render them as a pencil sketch'),
  e('fire', '🔥', 'نار', 'أنماط', 'add dramatic fire and ember effects around them'),
  e('ice', '❄️', 'ثلج', 'أنماط', 'add a frozen icy effect around them'),
  // Characters / costumes
  e('superhero', '🦸', 'بطل خارق', 'شخصيات', 'dress them as a superhero with a costume and cape'),
  e('wizard', '🧙', 'ساحر', 'شخصيات', 'dress them as a fantasy wizard with robe and hat'),
  e('knight', '🛡', 'فارس', 'شخصيات', 'dress them as a medieval knight in armor'),
  e('astronaut', '👨‍🚀', 'رائد فضاء', 'شخصيات', 'dress them as an astronaut in a space suit'),
  e('pirate', '🏴‍☠️', 'قرصان', 'شخصيات', 'dress them as a pirate captain'),
  e('cowboy', '🤠', 'راعي بقر', 'شخصيات', 'dress them as a cowboy'),
  e('ninja', '🥷', 'نينجا', 'شخصيات', 'dress them as a ninja'),
  e('robot', '🤖', 'روبوت', 'شخصيات', 'turn them into a friendly humanoid robot'),
  e('zombie', '🧟', 'زومبي', 'شخصيات', 'give them a fun halloween zombie look'),
  e('king', '👑', 'ملك', 'شخصيات', 'dress them as a royal king/queen with a crown'),
  e('detective', '🕵️', 'محقق', 'شخصيات', 'dress them as a classic detective'),
  e('police', '👮', 'شرطي', 'شخصيات', 'dress them in a police officer uniform'),
  e('firefighter', '👨‍🚒', 'إطفائي', 'شخصيات', 'dress them as a firefighter'),
  e('doctor', '👨‍⚕️', 'طبيب', 'شخصيات', 'dress them as a doctor in a white coat'),
  e('chef', '👨‍🍳', 'طباخ', 'شخصيات', 'dress them as a chef with a chef hat'),
  // Animal meme bodies
  e('horse', '🐴', 'جسم حصان', 'حيوانات', 'humorously place their face on a horse body, meme style'),
  e('monkey', '🐵', 'جسم قرد', 'حيوانات', 'humorously place their face on a monkey body, meme style'),
  e('penguin', '🐧', 'جسم بطريق', 'حيوانات', 'humorously place their face on a penguin body, meme style'),
  e('lion', '🦁', 'جسم أسد', 'حيوانات', 'humorously place their face on a lion body, meme style'),
  e('frog', '🐸', 'ضفدع', 'حيوانات', 'humorously place their face on a frog, meme style'),
  e('duck', '🦆', 'بطة', 'حيوانات', 'humorously place their face on a duck, meme style'),
  // Accessories
  e('glasses', '🕶', 'نظارة', 'إكسسوارات', 'add stylish sunglasses'),
  e('hat', '🎩', 'قبعة', 'إكسسوارات', 'add an elegant top hat'),
  e('crown', '👑', 'تاج', 'إكسسوارات', 'add a golden crown'),
  e('beard', '🧔', 'لحية', 'إكسسوارات', 'add a thick well-groomed beard'),
  // Backgrounds (scenery only — fully clothed)
  e('space', '🌌', 'فضاء', 'خلفيات', 'place them (fully clothed) in outer space with stars'),
  e('castle', '🏰', 'قلعة', 'خلفيات', 'place them (fully clothed) in front of a fantasy castle'),
  e('forest', '🌲', 'غابة', 'خلفيات', 'place them (fully clothed) in a beautiful forest'),
  e('city', '🏙', 'مدينة', 'خلفيات', 'place them (fully clothed) in a modern city skyline'),
  e('beach', '🏖', 'شاطئ', 'خلفيات', 'place them (fully clothed) standing at a sunny beach'),
  // Age
  e('older', '👴', 'عجوز', 'العمر', 'make them look elderly with grey hair and wrinkles'),
  e('younger', '👶', 'أصغر', 'العمر', 'make them look like a young child'),
];

export const EFFECT_GROUPS = [...new Set(EFFECTS.map((x) => x.group))];

export function findEffect(id: string): Effect | undefined {
  return EFFECTS.find((x) => x.id === id);
}
