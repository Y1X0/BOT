import { readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { createLogger } from '../../core/logger';

const log = createLogger('pdf:browser');

/** Resolve a Chromium binary: env override → Playwright layout → system → PATH. */
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
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (existsSync(p)) return p;
  }
  // Last resort: whatever is on PATH (e.g. a Nix-provided chromium).
  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable']) {
    try {
      const p = execSync(`command -v ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (p && existsSync(p)) return p;
    } catch {
      /* not on PATH */
    }
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
  const executablePath = resolveExecutable();
  if (!executablePath) {
    throw new Error(
      'Chromium غير مثبّت على الخادم. ثبّت chromium (عبر nixpacks.toml) أو عيّن PDF_CHROME_PATH.',
    );
  }
  browserPromise = chromium.launch({
    executablePath,
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
