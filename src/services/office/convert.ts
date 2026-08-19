import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/logger';

const log = createLogger('office:convert');

// Last failure reason, surfaced to the user so conversion issues are diagnosable.
let lastError = '';
export const getLastConvertError = (): string => lastError;

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
  lastError = '';
  const dir = await mkdtemp(join(tmpdir(), 'conv-')).catch(() => null);
  if (!dir) {
    lastError = 'tmpdir failed';
    return null;
  }
  try {
    const inPath = join(dir, `input.${sourceExt.toLowerCase()}`);
    await writeFile(inPath, input);
    const res = await runSoffice([
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--convert-to',
      FILTER[target],
      '--outdir',
      dir,
      inPath,
      `-env:UserInstallation=file://${join(dir, 'profile')}`,
    ], dir);
    if (!res.ok) {
      lastError = res.err;
      return null;
    }
    const files = await readdir(dir).catch(() => [] as string[]);
    const outName = files.find((f) => f !== `input.${sourceExt.toLowerCase()}` && f.endsWith(`.${target}`));
    if (!outName) {
      lastError = res.err || 'لم يُنتج LibreOffice ملف الإخراج';
      log.warn({ files, target, err: res.err }, 'converted output not found');
      return null;
    }
    return await readFile(join(dir, outName)).catch(() => null);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runSoffice(args: string[], home: string): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('soffice', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
    const grab = (d: Buffer) => {
      out = (out + d.toString()).slice(-400);
    };
    p.stdout?.on('data', grab);
    p.stderr?.on('data', grab);
    const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('error', (e) => {
      const code = (e as { code?: string }).code;
      resolve({ ok: false, err: code === 'ENOENT' ? 'LibreOffice غير مثبّت على الخادم' : e.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').map((l) => l.trim()).filter((l) => l && !/javaldx/i.test(l)).pop() || `exit ${code}`;
      if (code !== 0) log.warn({ code, out }, 'soffice convert failed');
      resolve({ ok: code === 0, err: line });
    });
  });
}
