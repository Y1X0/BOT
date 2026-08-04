export type PdfStep = 'title' | 'type' | 'customtype' | 'cover' | 'content';

export interface PdfState {
  chatId: number;
  step: PdfStep;
  title?: string;
  typeKey?: string; // theme key
  customType?: string;
  cover: { label: string; value: string }[];
  contentParts: string[];
  images: { dataUri: string; caption?: string }[];
  startedAt: number;
}

const states = new Map<number, PdfState>(); // keyed by userId

export function startPdf(userId: number, chatId: number): PdfState {
  const s: PdfState = { chatId, step: 'title', cover: [], contentParts: [], images: [], startedAt: Date.now() };
  states.set(userId, s);
  return s;
}
export const getPdf = (userId: number): PdfState | undefined => states.get(userId);
export const clearPdf = (userId: number): void => void states.delete(userId);
export const isAwaitingPdf = (userId: number): boolean => states.has(userId);

/** Parse "label: value" lines from the cover message. */
export function parseCoverFields(text: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(line);
    if (m) out.push({ label: m[1].trim(), value: m[2].trim() });
  }
  return out;
}
