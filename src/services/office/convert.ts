import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/logger';

const log = createLogger('office:convert');

export type ConvertTarget = 'pdf' | 'docx' | 'pptx';

// LibreOffice --convert-to filter strings per target format.
const FILTER: Record<ConvertTarget, string> = {
  pdf: 'pdf',
  docx: 'docx:MS Word 2007 XML',
  pptx: 'pptx:Impress MS PowerPoint 2007 XML',
};

/** Targets LibreOffice can actually produce for each source (no cross paths
 * like Word↔PowerPoint or PDF→PowerPoint — LibreOffice has no filter for those). */
export const CONVERT_TARGETS: Record<string, ConvertTarget[]> = {
  pdf: ['docx'], // PDF → Word (quality varies with the PDF)
  docx: ['pdf'],
  doc: ['pdf'],
  odt: ['pdf'],
  rtf: ['pdf'],
  pptx: ['pdf'],
  ppt: ['pdf'],
  odp: ['pdf'],
  xlsx: ['pdf'],
  xls: ['pdf'],
  jpg: ['pdf'],
  jpeg: ['pdf'],
  png: ['pdf'],
  webp: ['pdf'],
};

/**
 * Convert a document/image buffer to another format using headless LibreOffice.
 * A unique user-profile dir per call allows concurrent conversions. Returns the
 * converted buffer, or null on failure.
 */
export async function convertDocument(input: Buffer, sourceExt: string, target: ConvertTarget): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'conv-')).catch(() => null);
  if (!dir) return null;
  try {
    const inPath = join(dir, `input.${sourceExt.toLowerCase()}`);
    await writeFile(inPath, input);
    const ok = await runSoffice([
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--convert-to',
      FILTER[target],
      '--outdir',
      dir,
      inPath,
      `-env:UserInstallation=file://${join(dir, 'profile')}`,
    ], dir);
    if (!ok) return null;
    const files = await readdir(dir).catch(() => [] as string[]);
    const outName = files.find((f) => f !== `input.${sourceExt.toLowerCase()}` && f.endsWith(`.${target}`));
    if (!outName) {
      log.warn({ files, target }, 'converted output not found');
      return null;
    }
    return await readFile(join(dir, outName)).catch(() => null);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runSoffice(args: string[], home: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('soffice', args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: home } });
    let err = '';
    p.stderr?.on('data', (d) => {
      err = (err + d.toString()).slice(-300);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('error', (e) => {
      log.warn({ e }, 'soffice spawn error');
      resolve(false);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) log.warn({ code, err }, 'soffice convert failed');
      resolve(code === 0);
    });
  });
}
