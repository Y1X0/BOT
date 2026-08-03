/** Pure helper: extract the largest photo's file id from a message. */
export function largestPhoto(msg: unknown): { fileId: string } | null {
  const photos = (msg as { photo?: Array<{ file_id: string }> })?.photo;
  if (!photos?.length) return null;
  return { fileId: photos[photos.length - 1].file_id };
}

/** Does a caption ask for a sticker conversion? */
export function wantsSticker(caption: string | undefined): boolean {
  if (!caption) return false;
  return /ملصق|ستيكر|sticker/i.test(caption);
}
