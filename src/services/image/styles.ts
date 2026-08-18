/**
 * Tested style presets for the free (FLUX-schnell) models. These append concrete
 * material/lighting/camera keywords — NOT vague tokens like "8k, hyperrealistic"
 * which actually degrade the fast free models — so results come out clean and
 * consistent instead of mushy. Users pick a style; the suffix is added silently.
 */
export interface StylePreset {
  id: string;
  label: string;
  suffix: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'realistic',
    label: '📷 واقعي',
    suffix:
      ', realistic photography, soft natural lighting, detailed skin and fabric textures, sharp focus, shallow depth of field, taken with a 50mm lens',
  },
  {
    id: 'cinematic',
    label: '🎬 سينمائي',
    suffix:
      ', cinematic film still, dramatic moody lighting, volumetric light, rich warm color grading, sharp focus, shallow depth of field',
  },
  {
    id: 'portrait',
    label: '👤 بورتريه',
    suffix:
      ', studio portrait, soft key light, clean simple background, detailed facial features, sharp eyes, professional headshot',
  },
  {
    id: 'anime',
    label: '🌸 أنمي',
    suffix: ', anime illustration, clean line art, vibrant cel shading, detailed background, studio quality',
  },
  {
    id: '3d',
    label: '🧊 ثري دي',
    suffix: ', 3d render, octane render, soft global illumination, detailed materials, smooth polished surfaces',
  },
  {
    id: 'vector',
    label: '🎨 فيكتور',
    suffix: ', flat vector illustration, clean bold shapes, minimal, crisp edges, solid flat colors',
  },
  {
    id: 'fantasy',
    label: '🐉 فانتازيا',
    suffix: ', epic fantasy concept art, dramatic atmosphere, detailed environment, painterly, rich colors',
  },
];

export const DEFAULT_STYLE = 'realistic';

export function findStyle(idOrLabel: string): StylePreset | undefined {
  const q = idOrLabel.trim().toLowerCase();
  return STYLE_PRESETS.find((s) => s.id === q || s.label.includes(idOrLabel.trim()));
}

/** The keyword suffix for a style id (falls back to the default style). */
export function styleSuffix(id: string): string {
  const s = STYLE_PRESETS.find((p) => p.id === id) ?? STYLE_PRESETS.find((p) => p.id === DEFAULT_STYLE)!;
  return s.suffix;
}
