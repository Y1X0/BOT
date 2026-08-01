import { describe, it, expect } from 'vitest';
import { isPromptAllowed, PG_SUFFIX } from '../src/services/image/safety';

describe('image prompt safety', () => {
  it('allows wholesome PG prompts', () => {
    expect(isPromptAllowed('قلعة فوق الغيوm')).toBe(true);
    expect(isPromptAllowed('a cute robot in a forest')).toBe(true);
    expect(isPromptAllowed('رائد فضاء يشرب قهوة')).toBe(true);
  });

  it('blocks sexual/nudity requests (en + ar)', () => {
    expect(isPromptAllowed('a nude person')).toBe(false);
    expect(isPromptAllowed('NSFW picture')).toBe(false);
    expect(isPromptAllowed('صورة عارية')).toBe(false);
    expect(isPromptAllowed('محتوى جنسي')).toBe(false);
    expect(isPromptAllowed('بكيني')).toBe(false);
  });

  it('blocks gore requests', () => {
    expect(isPromptAllowed('a bloody corpse')).toBe(false);
    expect(isPromptAllowed('جثة')).toBe(false);
  });

  it('normalizes Arabic diacritics/alef forms when matching', () => {
    expect(isPromptAllowed('جِنسي')).toBe(false); // with harakat
  });

  it('exposes a PG guardrail suffix', () => {
    expect(PG_SUFFIX.toLowerCase()).toContain('pg');
  });
});
