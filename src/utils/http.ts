/** Small fetch helpers with timeout — shared by feature plugins. */
const UA = 'Mozilla/5.0 (compatible; TelegramBot/1.0)';

export async function getJson<T = unknown>(url: string, timeoutMs = 12_000): Promise<T | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getText(url: string, timeoutMs = 12_000): Promise<string | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
