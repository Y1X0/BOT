/** In-memory ring buffer of recent errors, surfaced in the owner dashboard. */
export interface RecordedError {
  time: number;
  message: string;
  context?: string;
}

const buffer: RecordedError[] = [];
const MAX = 100;

export function recordError(message: string, context?: string): void {
  buffer.push({ time: Date.now(), message: message.slice(0, 500), context });
  if (buffer.length > MAX) buffer.shift();
}

export function recentErrors(): RecordedError[] {
  return [...buffer].reverse();
}

export function clearErrors(): void {
  buffer.length = 0;
}
