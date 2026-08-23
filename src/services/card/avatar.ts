import { loadImage, type Image } from '@napi-rs/canvas';
import type { Telegram } from 'telegraf';

/** Fetch a user's profile photo and decode it for canvas drawing (or null). */
export async function fetchAvatar(telegram: Telegram, userId: number): Promise<Image | null> {
  try {
    const photos = await telegram.getUserProfilePhotos(userId, 0, 1);
    const sizes = photos?.photos?.[0];
    if (!sizes?.length) return null;
    const fid = sizes[sizes.length - 1].file_id; // largest available
    const link = await telegram.getFileLink(fid);
    const res = await fetch(link.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}
