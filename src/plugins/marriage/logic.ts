/** Pure helper for the marriage feature: human duration in Arabic. */

export function marriedDuration(marriedAt: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - marriedAt.getTime());
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return 'اليوم 🎉';
  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومان';
  if (days < 11) return `${days} أيام`;
  if (days < 30) return `${days} يوماً`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? 'شهر' : `${months} أشهر`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'سنة' : `${years} سنوات`;
}
