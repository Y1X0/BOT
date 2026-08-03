import { describe, it, expect } from 'vitest';
import { largestPhoto, wantsSticker } from '../src/plugins/sticker/logic';

describe('largestPhoto', () => {
  it('returns the last (largest) photo size', () => {
    const msg = { photo: [{ file_id: 'small' }, { file_id: 'big' }] };
    expect(largestPhoto(msg)).toEqual({ fileId: 'big' });
  });
  it('returns null when there is no photo', () => {
    expect(largestPhoto({})).toBeNull();
    expect(largestPhoto(undefined)).toBeNull();
    expect(largestPhoto({ photo: [] })).toBeNull();
  });
});

describe('wantsSticker', () => {
  it('detects sticker requests in a caption', () => {
    expect(wantsSticker('ملصق')).toBe(true);
    expect(wantsSticker('حوّلها ستيكر')).toBe(true);
    expect(wantsSticker('make a sticker')).toBe(true);
  });
  it('is false otherwise', () => {
    expect(wantsSticker('صورة حلوة')).toBe(false);
    expect(wantsSticker(undefined)).toBe(false);
  });
});
