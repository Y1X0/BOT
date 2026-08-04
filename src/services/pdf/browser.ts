import { readdirSync, existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { createLogger } from '../../core/logger';

const log = createLogger('pdf:browser');

/** Resolve the pre-installed Chromium binary (Playwright layout or system). */
function resolveExecutable(): string | undefined {
  if (process.env.PDF_CHROME_PATH && existsSync(process.env.PDF_CHROME_PATH)) return process.env.PDF_CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    // Prefer a full "chromium-*" build (has print support) over headless_shell.
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const p = `${root}/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  } catch {
    /* fall through to system paths */
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

let browserPromise: Promise<Browser> | null = null;

/** Lazily launch a shared headless Chromium and reuse it across renders. */
export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = chromium.launch({
    executablePath: resolveExecutable(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const browser = await browserPromise;
  browser.on('disconnected', () => {
    browserPromise = null;
  });
  log.info('Chromium launched for PDF rendering');
  return browser;
}

export async function closeBrowser(): Promise<void> {
  const b = await browserPromise?.catch(() => null);
  if (b) await b.close().catch(() => undefined);
  browserPromise = null;
}
